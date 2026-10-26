import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { GraphileJobPublisher, GraphileJobWorkerHost } from "./wakeup.js";

const databaseUrl = process.env.DATABASE_URL;
const describePostgres =
  process.env.VERIFY_DATABASE && databaseUrl ? describe.sequential : describe.skip;

function handlers(overrides: Partial<BackgroundJobHandlers> = {}): BackgroundJobHandlers {
  return {
    "run.continue": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(assertion: () => void, timeoutMs = 10_000): Promise<void> {
  await vi.waitFor(assertion, { timeout: timeoutMs, interval: 25 });
}

describePostgres("Graphile background jobs (PostgreSQL contract)", () => {
  it("dispatches lifecycle jobs while all four long-work slots are occupied", async () => {
    const publisher = new GraphileJobPublisher(databaseUrl!);
    const host = new GraphileJobWorkerHost(databaseUrl!, {
      pollInterval: 25,
      noHandleSignals: true,
    });
    const release = deferred();
    let active = 0;
    const target = handlers({
      "run.continue": async () => {
        active += 1;
        await release.promise;
        active -= 1;
      },
    });
    try {
      await host.start(target);
      for (let index = 0; index < 5; index += 1) {
        await publisher.enqueue({
          name: "run.continue",
          payload: { runId: `saturation-${index}` },
        });
      }
      await waitFor(() => expect(active).toBe(4));
      const started = performance.now();
      await publisher.enqueue({
        name: "routine.wakeup",
        payload: { routineId: "due", scheduledFor: new Date().toISOString() },
      });
      await publisher.enqueue({
        name: "computer.control-expire",
        payload: { computerId: "computer", leaseId: "lease" },
      });
      await publisher.enqueue({ name: "computer.sleep", payload: { computerId: "computer" } });
      await publisher.enqueue({ name: "skill.teaching-expire", payload: { skillId: "skill" } });
      await waitFor(() => {
        expect(target["routine.wakeup"]).toHaveBeenCalledOnce();
        expect(target["computer.control-expire"]).toHaveBeenCalledOnce();
        expect(target["computer.sleep"]).toHaveBeenCalledOnce();
        expect(target["skill.teaching-expire"]).toHaveBeenCalledOnce();
      });
      expect(active).toBe(4);
      console.info(
        `worker evidence: lifecycle jobs dispatched in ${Math.round(performance.now() - started)}ms with four agent slots held`,
      );
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it("waits for an active handler during graceful shutdown", async () => {
    const publisher = new GraphileJobPublisher(databaseUrl!);
    const host = new GraphileJobWorkerHost(databaseUrl!, { concurrency: 1, pollInterval: 25 });
    const entered = deferred();
    const release = deferred();
    let completed = false;
    const target = handlers({
      "run.continue": async () => {
        entered.resolve();
        await release.promise;
        completed = true;
      },
    });

    try {
      await host.start(target);
      await publisher.enqueue({ name: "run.continue", payload: { runId: "graceful-stop" } });
      await entered.promise;

      let stopped = false;
      const stopping = host.stop().then(() => {
        stopped = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stopped).toBe(false);

      release.resolve();
      await stopping;
      expect(completed).toBe(true);
    } finally {
      release.resolve();
      await host.stop();
      await publisher.close();
    }
  });

  it("replaces a keyed delayed job without running the old payload or schedule", async () => {
    const publisher = new GraphileJobPublisher(databaseUrl!);
    const host = new GraphileJobWorkerHost(databaseUrl!, { concurrency: 1, pollInterval: 25 });
    const received: string[] = [];
    const target = handlers({
      "computer.sleep": async ({ computerId }) => {
        received.push(computerId);
      },
    });
    const key = `contract:replacement:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "old" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "replacement" },
        availableAt: new Date(Date.now() + 800),
        replaceKey: key,
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(received).toEqual([]);
      await waitFor(() => expect(received).toEqual(["replacement"]));
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });

  it("removes a keyed delayed job before a worker can run it", async () => {
    const publisher = new GraphileJobPublisher(databaseUrl!);
    const host = new GraphileJobWorkerHost(databaseUrl!, { concurrency: 1, pollInterval: 25 });
    const target = handlers();
    const key = `contract:cancellation:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "computer.sleep",
        payload: { computerId: "cancelled" },
        availableAt: new Date(Date.now() + 300),
        replaceKey: key,
      });
      await publisher.cancel(key);
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(target["computer.sleep"]).not.toHaveBeenCalled();
    } finally {
      await host.stop();
      await publisher.close();
    }
  });

  it("persists a handler failure and retries the job successfully", async () => {
    const publisher = new GraphileJobPublisher(databaseUrl!);
    const host = new GraphileJobWorkerHost(databaseUrl!, { concurrency: 1, pollInterval: 25 });
    let attempts = 0;
    const target = handlers({
      "run.continue": async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("intentional contract-test failure");
      },
    });
    const key = `contract:retry:${Date.now()}`;

    try {
      await host.start(target);
      await publisher.enqueue({
        name: "run.continue",
        payload: { runId: "retry" },
        replaceKey: key,
      });
      await waitFor(() => expect(attempts).toBe(2), 15_000);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(attempts).toBe(2);
    } finally {
      await host.stop();
      await publisher.cancel(key).catch(() => undefined);
      await publisher.close();
    }
  });
});
