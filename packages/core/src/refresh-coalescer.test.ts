import { describe, expect, it, vi } from "vitest";
import { createRefreshCoalescer } from "./refresh-coalescer.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("event refresh coalescing", () => {
  it("reduces 100 invalidations during a read to one trailing read and waits for it", async () => {
    const first = deferred();
    const trailing = deferred();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(trailing.promise);
    const coalescer = createRefreshCoalescer(read);
    const done = coalescer.invalidate();
    await Promise.resolve();
    const joined = Array.from({ length: 100 }, () => coalescer.invalidate());
    expect(joined.every((promise) => promise === done)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    first.resolve();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    trailing.resolve();
    await done;
    expect(read).toHaveBeenCalledTimes(2);
    await coalescer.invalidate();
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("retains invalidations during the trailing read", async () => {
    const first = deferred();
    const trailing = deferred();
    const read = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(trailing.promise)
      .mockResolvedValue(undefined);
    const coalescer = createRefreshCoalescer(read);
    const done = coalescer.invalidate();
    await Promise.resolve();
    coalescer.invalidate();
    first.resolve();
    await Promise.resolve();
    coalescer.invalidate();
    trailing.resolve();
    await done;
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("still performs a trailing read after failure and allows retry after a final failure", async () => {
    const first = deferred();
    const read = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const coalescer = createRefreshCoalescer(read);
    const done = coalescer.invalidate();
    await Promise.resolve();
    coalescer.invalidate();
    first.reject(new Error("stale failure"));
    await done;
    expect(read).toHaveBeenCalledTimes(2);
    await expect(coalescer.invalidate()).rejects.toThrow("offline");
    await coalescer.invalidate();
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("discards queued work on disposal and keeps separate thread subscriptions independent", async () => {
    const first = deferred();
    const oldRead = vi.fn().mockReturnValue(first.promise);
    const oldThread = createRefreshCoalescer(oldRead);
    const newRead = vi.fn().mockResolvedValue(undefined);
    const newThread = createRefreshCoalescer(newRead);
    const done = oldThread.invalidate();
    await Promise.resolve();
    oldThread.invalidate();
    oldThread.dispose();
    await newThread.invalidate();
    first.resolve();
    await done;
    await oldThread.invalidate();
    expect(oldRead).toHaveBeenCalledTimes(1);
    expect(newRead).toHaveBeenCalledTimes(1);
  });

  it("retains an invalidation queued at the read-completion microtask boundary", async () => {
    const first = deferred();
    const read = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const coalescer = createRefreshCoalescer(read);
    const done = coalescer.invalidate();
    await Promise.resolve();
    const next = first.promise.then(() => coalescer.invalidate());
    first.resolve();
    await Promise.all([done, next]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
