import {
  type BackgroundJob,
  type BackgroundJobHandlers,
  dispatchBackgroundJob,
  type JobPublisher,
  type JobWorkerHost,
} from "@rakazo/adapter-kit";
import { makeWorkerUtils, type Runner, run, type WorkerUtils } from "graphile-worker";

export class GraphileJobPublisher implements JobPublisher {
  private utils: Promise<WorkerUtils> | undefined;
  private closed = false;

  constructor(private readonly connectionString: string) {}

  async enqueue(job: BackgroundJob): Promise<void> {
    const utils = await this.getUtils();
    await utils.addJob(job.name, job.payload, {
      runAt: job.availableAt,
      jobKey: job.replaceKey,
    });
  }

  async cancel(key: string): Promise<void> {
    const utils = await this.getUtils();
    await utils.withPgClient(async (client) => {
      await client.query("select graphile_worker.remove_job($1::text)", [key]);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.utils) await (await this.utils).release();
  }

  private getUtils(): Promise<WorkerUtils> {
    if (this.closed) throw new Error("Background job publisher is closed");
    this.utils ??= makeWorkerUtils({ connectionString: this.connectionString });
    return this.utils;
  }
}

export class GraphileJobWorkerHost implements JobWorkerHost {
  private runners: Runner[] = [];
  private starting: Promise<void> | undefined;

  constructor(
    private readonly connectionString: string,
    private readonly options: {
      concurrency?: number;
      controlConcurrency?: number;
      pollInterval?: number;
      noHandleSignals?: boolean;
    } = {},
  ) {}

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    if (this.starting) return this.starting;
    if (this.runners.length) return;
    this.starting = this.startPools(handlers).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startPools(handlers: BackgroundJobHandlers): Promise<void> {
    const concurrency = this.options.concurrency ?? 4;
    const controlConcurrency = this.options.controlConcurrency ?? 1;
    for (const count of [concurrency, controlConcurrency]) {
      if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid worker concurrency");
    }
    const taskList = Object.fromEntries(
      Object.keys(handlers).map((name) => [
        name,
        async (payload: unknown) => dispatchBackgroundJob(handlers, name, payload),
      ]),
    );
    // Long agent/LLM calls cannot consume the capacity reserved for lifecycle work.
    // Graphile still owns claiming, retries and queue locks in both bounded pools.
    const isLongTask = (name: string) => name === "run.continue" || name === "history.compact";
    try {
      for (const longTasks of [true, false]) {
        const tasks = Object.fromEntries(
          Object.entries(taskList).filter(([name]) => isLongTask(name) === longTasks),
        );
        if (!Object.keys(tasks).length) continue;
        this.runners.push(
          await run({
            connectionString: this.connectionString,
            concurrency: longTasks ? concurrency : controlConcurrency,
            pollInterval: this.options.pollInterval ?? 500,
            noHandleSignals: this.options.noHandleSignals,
            taskList: tasks,
          }),
        );
      }
    } catch (error) {
      await this.stopPools();
      throw error;
    }
  }

  private async stopPools(): Promise<void> {
    const runners = this.runners;
    this.runners = [];
    const results = await Promise.allSettled(runners.map((runner) => runner.stop()));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => undefined);
    await this.stopPools();
  }
}

export class InMemoryJobQueue implements JobPublisher, JobWorkerHost {
  private handlers: BackgroundJobHandlers | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly keyed = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  async enqueue(job: BackgroundJob): Promise<void> {
    if (this.closed) throw new Error("Background job publisher is closed");
    if (job.replaceKey) await this.cancel(job.replaceKey);
    const delay = job.availableAt ? Math.max(0, job.availableAt.getTime() - Date.now()) : 0;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (job.replaceKey && this.keyed.get(job.replaceKey) === timer) {
        this.keyed.delete(job.replaceKey);
      }
      const handlers = this.handlers;
      if (!handlers) return;
      void dispatchBackgroundJob(handlers, job.name, job.payload).catch((error) =>
        console.error(job.name, error),
      );
    }, delay);
    this.timers.add(timer);
    if (job.replaceKey) this.keyed.set(job.replaceKey, timer);
  }

  async cancel(key: string): Promise<void> {
    const timer = this.keyed.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.keyed.delete(key);
    this.timers.delete(timer);
  }

  async start(handlers: BackgroundJobHandlers): Promise<void> {
    this.handlers = handlers;
  }

  async stop(): Promise<void> {
    this.handlers = undefined;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.keyed.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.stop();
  }
}
