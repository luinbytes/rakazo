import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { queryWorkspaceSearch } from "./search.js";

const actor: Actor = {
  workspaceId: "workspace",
  userId: "user",
  email: "test@example.test",
  isDeploymentOwner: false,
};
function fixture() {
  const prisma = {
    bot: { findMany: vi.fn().mockResolvedValue([]) },
    chatGroup: { findMany: vi.fn().mockResolvedValue([]) },
    artifact: { findMany: vi.fn().mockResolvedValue([]) },
    routine: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  return {
    prisma,
    search: (q = "needle") => queryWorkspaceSearch(prisma as unknown as PrismaClient, actor, q),
  };
}

describe("workspace search batching", () => {
  it("skips all database reads for a blank query", async () => {
    const { prisma, search } = fixture();
    expect(await search("  ")).toEqual([]);
    expect(prisma.bot.findMany).not.toHaveBeenCalled();
  });

  it("keeps artifact candidate order, skips missing references and stops lower-priority work when full", async () => {
    const { prisma, search } = fixture();
    const artifacts = Array.from({ length: 25 }, (_, i) => ({
      id: `a-${i}`,
      botId: "bot",
      bot: { name: "Bot" },
      name: `File ${i}`,
      mimeType: "text/plain",
      size: i,
    }));
    prisma.artifact.findMany.mockResolvedValueOnce(artifacts);
    prisma.$queryRaw.mockResolvedValueOnce(
      artifacts.toReversed().map((a, seq) => ({ artifactId: a.id, id: `m-${a.id}`, seq })),
    );
    expect((await search()).map((hit) => hit.artifactId)).toEqual(artifacts.map((a) => a.id));
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.artifact.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.routine.findMany).not.toHaveBeenCalled();
    const sql = prisma.$queryRaw.mock.calls[0]![0] as { text: string; values: unknown[] };
    expect(sql.text).toContain("CROSS JOIN LATERAL");
    expect(sql.values).toContain(actor.workspaceId);
    expect(sql.values).toContain(actor.userId);
  });

  it("preserves conversations, bot/group files, routines and message/link priority and dedupe", async () => {
    const { prisma, search } = fixture();
    prisma.bot.findMany.mockResolvedValue([{ id: "bot", name: "Bot", title: "Title" }]);
    prisma.chatGroup.findMany.mockResolvedValue([{ id: "group", name: "" }]);
    prisma.artifact.findMany
      .mockResolvedValueOnce([
        { id: "unattached", botId: "bot", bot: { name: "Bot" } },
        {
          id: "a",
          botId: "bot",
          bot: { name: "Bot" },
          name: "File",
          mimeType: "text/plain",
          size: 1,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "g",
          groupId: "group",
          group: { name: "" },
          name: "Group file",
          mimeType: "text/plain",
          size: 2,
        },
      ]);
    prisma.routine.findMany.mockResolvedValue([
      { id: "routine", botId: "bot", bot: { name: "Bot" }, name: "Routine", prompt: "needle" },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ artifactId: "a", id: "file-message", seq: 2 }])
      .mockResolvedValueOnce([{ artifactId: "g", id: "group-file-message", seq: 3 }])
      .mockResolvedValueOnce([
        {
          id: "text",
          botId: "bot",
          botName: "Bot",
          seq: 4,
          blocks: [
            { kind: "text", text: "needle https://example.test/needle" },
            { kind: "text", text: "needle https://example.test/needle" },
          ],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "group-text",
          groupId: "group",
          groupName: "",
          seq: 5,
          blocks: [{ kind: "text", text: "needle" }],
        },
      ]);
    const hits = await search();
    expect(hits.map((h) => h.kind)).toEqual([
      "conversation",
      "conversation",
      "file",
      "file",
      "routine",
      "message",
      "link",
      "message",
    ]);
    expect(hits[3]).toMatchObject({
      groupId: "group",
      groupName: "",
      messageId: "group-file-message",
      seq: 3,
    });
    expect(prisma.artifact.findMany.mock.calls[0]![0]).toMatchObject({
      where: {
        workspaceId: actor.workspaceId,
        userId: actor.userId,
        groupId: null,
        bot: { archivedAt: null },
      },
    });
  });
});
