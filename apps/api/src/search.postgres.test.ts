import { randomUUID } from "node:crypto";
import type { Actor, SearchHit } from "@rakazo/contracts";
import { createDb, type PrismaClient } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { queryWorkspaceSearch } from "./search.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("batched attachment search (PostgreSQL)", () => {
  const workspaceId = `search-${randomUUID()}`;
  const actor: Actor = {
    workspaceId,
    userId: `${workspaceId}-user`,
    email: "search@example.test",
    isDeploymentOwner: false,
  };
  const created = createDb(process.env.DATABASE_URL ?? "postgres://unused");
  let sqlCount = 0;
  let rawCount = 0;
  const prisma = created.prisma.$extends({
    query: {
      $allOperations({ operation, args, query }) {
        sqlCount++;
        if (operation === "$queryRaw") rawCount++;
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
  const botId = `${workspaceId}-bot`;
  const groupId = `${workspaceId}-group`;
  beforeAll(async () => {
    await prisma.organization.create({
      data: { id: workspaceId, name: "Search fixture", slug: workspaceId, createdAt: new Date() },
    });
    await prisma.bot.create({
      data: {
        id: botId,
        workspaceId,
        userId: actor.userId,
        name: "Bot",
        color: "#000",
        thread: { create: { id: `${botId}-thread`, workspaceId, userId: actor.userId } },
      },
    });
    await prisma.chatGroup.create({
      data: {
        id: groupId,
        workspaceId,
        userId: actor.userId,
        name: "Group",
        thread: { create: { id: `${groupId}-thread`, workspaceId, userId: actor.userId } },
      },
    });
    for (const destination of ["bot", "group"] as const) {
      const artifacts = Array.from({ length: 25 }, (_, i) => ({
        id: `${workspaceId}-${destination}-artifact-${i}`,
        workspaceId,
        userId: actor.userId,
        botId: destination === "bot" ? botId : null,
        groupId: destination === "group" ? groupId : null,
        name: `needle-${i}.txt`,
        mimeType: "text/plain",
        size: i,
        hash: "fixture",
        storageKey: "fixture",
      }));
      await prisma.artifact.createMany({ data: artifacts });
      const threadId = `${destination === "bot" ? botId : groupId}-thread`;
      for (const seq of [1, 2])
        await prisma.message.create({
          data: {
            threadId,
            seq,
            role: "user",
            blocks: artifacts.map((a) => ({ kind: "artifact", artifactId: a.id })),
            createdAt: new Date(`2026-01-0${seq}`),
          },
        });
    }
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
    await created.pool.end();
  });

  it("returns identical ordered hits with one attachment batch and no lower-priority reads", async () => {
    let baseline: SearchHit[] | undefined;
    let baselineOperations: number | undefined;
    let baselineMs: number | undefined;
    let baselineRawQueries: number | undefined;
    // Optional original-source oracle, materialized by the documented benchmark command.
    if (process.env.SEARCH_BASELINE === "1") {
      const url = new URL("./.baseline-search.ts", import.meta.url).href;
      const original = (await import(url)) as { queryWorkspaceSearch: typeof queryWorkspaceSearch };
      sqlCount = 0;
      rawCount = 0;
      const start = performance.now();
      baseline = await original.queryWorkspaceSearch(prisma, actor, "needle");
      baselineMs = performance.now() - start;
      baselineOperations = sqlCount;
      baselineRawQueries = rawCount;
    }
    sqlCount = 0;
    rawCount = 0;
    const start = performance.now();
    const hits = await queryWorkspaceSearch(prisma, actor, "needle");
    const elapsedMs = performance.now() - start;
    expect(hits).toHaveLength(25);
    expect(hits.every((hit) => hit.kind === "file" && hit.botId === botId && hit.seq === 2)).toBe(
      true,
    );
    expect(sqlCount).toBe(4); // bots + groups + artifacts + one raw batch
    expect(rawCount).toBe(1);
    if (baseline) expect(hits).toEqual(baseline);
    console.info(
      JSON.stringify({
        baselineOperations,
        baselineRawQueries,
        baselineMs,
        batchedOperations: sqlCount,
        batchedRawQueries: rawCount,
        elapsedMs,
        hits: hits.length,
      }),
    );
  });

  it("excludes another user's data and resolves group file references", async () => {
    expect(await queryWorkspaceSearch(prisma, { ...actor, userId: "other" }, "needle")).toEqual([]);
    expect(
      await queryWorkspaceSearch(prisma, { ...actor, workspaceId: "other" }, "needle"),
    ).toEqual([]);
    await prisma.artifact.deleteMany({ where: { workspaceId, botId } });
    const hits = await queryWorkspaceSearch(prisma, actor, "needle");
    expect(hits).toHaveLength(25);
    expect(
      hits.every((hit) => hit.kind === "file" && hit.groupId === groupId && hit.seq === 2),
    ).toBe(true);
  });
});
