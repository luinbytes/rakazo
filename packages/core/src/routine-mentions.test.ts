import { describe, expect, it, vi } from "vitest";
import { loadRoutineMentions } from "./routine-mentions.js";

describe("routine mention loading", () => {
  it("uses one batch and retains client bot order and each bot's existing routine order", async () => {
    const readBatch = vi.fn(async () => [
      { botId: "b", id: "b2" },
      { botId: "b", id: "b1" },
      { botId: "new-bot", id: "excluded" },
      { botId: "a", id: "a2" },
      { botId: "a", id: "a1" },
    ]);
    const readBot = vi.fn();
    expect(await loadRoutineMentions(["a", "b", "no-routines"], readBatch, readBot)).toEqual([
      { botId: "a", id: "a2" },
      { botId: "a", id: "a1" },
      { botId: "b", id: "b2" },
      { botId: "b", id: "b1" },
    ]);
    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(readBot).not.toHaveBeenCalled();
  });

  it("falls back for older servers with the original order and partial-failure behavior", async () => {
    const readBatch = vi.fn().mockRejectedValue(new Error("NOT_FOUND"));
    const readBot = vi.fn(async (botId: string) => {
      if (botId === "missing") throw new Error("Not found");
      return [{ botId, id: `${botId}-routine` }];
    });
    expect(await loadRoutineMentions(["a", "missing", "b"], readBatch, readBot)).toEqual([
      { botId: "a", id: "a-routine" },
      { botId: "b", id: "b-routine" },
    ]);
    expect(readBot.mock.calls).toEqual([["a"], ["missing"], ["b"]]);
  });
});
