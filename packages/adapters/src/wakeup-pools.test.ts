import type { BackgroundJobHandlers } from "@rakazo/adapter-kit";
import { run } from "graphile-worker";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GraphileJobWorkerHost } from "./wakeup.js";

vi.mock("graphile-worker", () => ({ run: vi.fn(), makeWorkerUtils: vi.fn() }));
const target: BackgroundJobHandlers = {
  "run.continue": async () => undefined,
  "routine.wakeup": async () => undefined,
  "computer.sleep": async () => undefined,
  "computer.control-expire": async () => undefined,
  "skill.teaching-expire": async () => undefined,
  "history.compact": async () => undefined,
};
const runMock = vi.mocked(run);
function runner(stop = vi.fn(async () => undefined)) {
  return { stop } as unknown as Awaited<ReturnType<typeof run>>;
}
beforeEach(() => vi.resetAllMocks());

describe("Graphile worker pools", () => {
  it("reserves bounded lifecycle capacity and dispatches validated payloads", async () => {
    const first = runner();
    const second = runner();
    runMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const onRun = vi.fn();
    const host = new GraphileJobWorkerHost("unused", { noHandleSignals: true });
    await Promise.all([host.start({ ...target, "run.continue": onRun }), host.start(target)]);
    expect(runMock).toHaveBeenCalledTimes(2);
    const long = runMock.mock.calls[0]?.[0];
    const control = runMock.mock.calls[1]?.[0];
    expect(long?.concurrency).toBe(4);
    expect(control?.concurrency).toBe(1);
    expect(Object.keys(long?.taskList ?? {}).sort()).toEqual(["history.compact", "run.continue"]);
    expect(Object.keys(control?.taskList ?? {}).sort()).toEqual([
      "computer.control-expire",
      "computer.sleep",
      "routine.wakeup",
      "skill.teaching-expire",
    ]);
    const task = long?.taskList?.["run.continue"];
    await task?.({ runId: "run-1" }, {} as never);
    expect(onRun).toHaveBeenCalledWith({ runId: "run-1" });
    await expect(task?.({ runId: "" }, {} as never)).rejects.toThrow();
    await host.stop();
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it("cleans the first pool if the second fails to start and allows retry", async () => {
    const first = runner();
    runMock.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("start failed"));
    const host = new GraphileJobWorkerHost("unused");
    await expect(host.start(target)).rejects.toThrow("start failed");
    expect(first.stop).toHaveBeenCalledOnce();
    runMock.mockResolvedValue(runner());
    await host.start(target);
    await host.stop();
    expect(runMock).toHaveBeenCalledTimes(4);
  });

  it("stops both pools even when one stop rejects", async () => {
    const first = runner(vi.fn().mockRejectedValue(new Error("stop failed")));
    const second = runner();
    runMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const host = new GraphileJobWorkerHost("unused");
    await host.start(target);
    await expect(host.stop()).rejects.toThrow("stop failed");
    expect(second.stop).toHaveBeenCalledOnce();
  });
});
