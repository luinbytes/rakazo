import { RPCHandler } from "@orpc/server/fetch";
import type { Actor } from "@rakazo/contracts";
import { loadRoutineMentions } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

const actor = {
  workspaceId: "workspace-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;
function routine(botId: string, suffix = "1") {
  return {
    id: `${botId}-routine-${suffix}`,
    botId,
    name: `Routine ${suffix}`,
    prompt: "Test prompt",
    crons: ["0 9 * * *"],
    timezone: "UTC",
    active: false,
    notify: true,
    webhookEnabled: false,
    lastRunAt: null,
    nextRunAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}
function harness(ids = ["bot-1", "bot-2"]) {
  const findBots = vi.fn(async () => [...ids].reverse().map((id) => ({ id })));
  const getBot = vi.fn(async ({ where }: { where: { id: string } }) =>
    ids.includes(where.id) ? { id: where.id } : null,
  );
  const findRoutines = vi.fn(
    async ({ where }: { where: { botId: string; workspaceId: string } }) => [
      routine(where.botId, "2"),
      routine(where.botId, "1"),
    ],
  );
  const deps = {
    prisma: {
      bot: { findMany: findBots, findFirst: getBot },
      routine: { findMany: findRoutines },
    } as unknown as PrismaClient,
    env: {
      defaultProvider: "fake",
      defaultModel: "fake",
      webOrigin: "http://127.0.0.1:5173",
      screenProxySecret: "fake-test-secret",
      sandboxProvider: "fake",
    },
    dataDir: "/tmp/rakazo-mention-test",
  } as unknown as RouterDeps;
  const handler = new RPCHandler(createRouter(deps));
  async function request(path: string, input: unknown, requestActor: Actor | null = actor) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: input }),
      }),
      { prefix: "/rpc", context: { actor: requestActor } },
    );
    return response;
  }
  return { findBots, getBot, findRoutines, request };
}

describe("batched routine mentions", () => {
  it("matches per-bot results and order with one HTTP request and one ownership query for 100 bots", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `bot-${i}`);
    const { findBots, getBot, findRoutines, request } = harness(ids);
    const oldResults = await Promise.all(
      ids.map(async (botId) => {
        const response = await request("routines/list", { botId });
        expect(response.status).toBe(200);
        return (await response.json()).json;
      }),
    );
    expect(getBot).toHaveBeenCalledTimes(100);
    expect(findRoutines).toHaveBeenCalledTimes(100);
    getBot.mockClear();
    findRoutines.mockClear();
    const response = await request("routines/listForMentions", {});
    expect(response.status).toBe(200);
    expect(
      await loadRoutineMentions(
        ids,
        async () => (await response.json()).json,
        async () => [],
      ),
    ).toEqual(oldResults.flat());
    expect(findBots).toHaveBeenCalledExactlyOnceWith({
      where: {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        archivedAt: null,
      },
      select: { id: true },
    });
    expect(getBot).not.toHaveBeenCalled();
    expect(findRoutines).toHaveBeenCalledTimes(100);
    expect(
      findRoutines.mock.calls.every(([query]) => query.where.workspaceId === actor.workspaceId),
    ).toBe(true);
  });

  it("does not read routines for bots excluded by ownership/workspace/archive isolation", async () => {
    const { request, findBots, findRoutines } = harness();
    const response = await request("routines/listForMentions", {});
    expect(response.status).toBe(200);
    const rows = (await response.json()).json;
    expect(rows.map((row: { botId: string }) => row.botId)).toEqual([
      "bot-2",
      "bot-2",
      "bot-1",
      "bot-1",
    ]);
    expect(findBots.mock.calls[0]).toBeDefined();
    expect(findRoutines).toHaveBeenCalledTimes(2);
    expect(findRoutines.mock.calls.map(([query]) => query.where.botId)).toEqual(["bot-2", "bot-1"]);
  });

  it("retains successful bots when one routine read fails", async () => {
    const { request, findRoutines } = harness();
    findRoutines.mockRejectedValueOnce(new Error("temporary read failure"));
    const response = await request("routines/listForMentions", {});
    expect(response.status).toBe(200);
    expect((await response.json()).json.map((row: { botId: string }) => row.botId)).toEqual([
      "bot-1",
      "bot-1",
    ]);
  });

  it("requires authentication before database access", async () => {
    const { request, findBots, findRoutines } = harness();
    expect((await request("routines/listForMentions", {}, null)).status).toBe(401);
    expect(findBots).not.toHaveBeenCalled();
    expect(findRoutines).not.toHaveBeenCalled();
  });

  it("returns no suggestions for an actor with no active owned bots", async () => {
    const { request, findRoutines } = harness([]);
    const response = await request("routines/listForMentions", {});
    expect(response.status).toBe(200);
    expect((await response.json()).json).toEqual([]);
    expect(findRoutines).not.toHaveBeenCalled();
  });
});
