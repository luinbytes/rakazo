import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "./client.js";
import { createGroupRepos } from "./groups.js";
import { latestMessageBlocks } from "./latest-message-blocks.js";
import { createRepos } from "./repos.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("sidebar latest messages (PostgreSQL)", () => {
  const workspaceId = `sidebar-${randomUUID()}`;
  const actor = {
    workspaceId,
    userId: `${workspaceId}-user`,
    email: "sidebar@example.test",
    isDeploymentOwner: false,
  };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: [{ emit: "event", level: "query" }],
  });
  const queries: Array<{ query: string; params: string }> = [];
  prisma.$on("query", (event) => queries.push(event));
  let threadIds: string[];
  beforeAll(async () => {
    await prisma.organization.create({
      data: { id: workspaceId, name: "Sidebar fixture", slug: workspaceId, createdAt: new Date() },
    });
    for (let i = 0; i < 10; i++) {
      await prisma.bot.create({
        data: {
          id: `${workspaceId}-bot-${i}`,
          workspaceId,
          userId: actor.userId,
          name: `Bot ${i}`,
          color: "#000",
          pinned: i === 3,
          archivedAt: i === 9 ? new Date() : null,
          thread: {
            create: {
              id: `${workspaceId}-thread-${i}`,
              workspaceId,
              userId: actor.userId,
              unread: i === 3,
            },
          },
        },
      });
    }
    const group = await prisma.chatGroup.create({
      data: {
        workspaceId,
        userId: actor.userId,
        name: "Group",
        members: { create: [0, 1].map((i) => ({ botId: `${workspaceId}-bot-${i}` })) },
        thread: {
          create: { id: `${workspaceId}-group-thread`, workspaceId, userId: actor.userId },
        },
      },
    });
    expect(group.name).toBe("Group");
    threadIds = (
      await prisma.thread.findMany({ where: { workspaceId }, select: { id: true } })
    ).map((t) => t.id);
    // One empty thread; 20,000 historical messages, with time order opposite sequence order.
    await prisma.$executeRaw`
      INSERT INTO messages (id, "threadId", seq, role, blocks, "createdAt")
      SELECT t.id || '-message-' || s, t.id, s, 'bot',
        jsonb_build_array(jsonb_build_object('kind', 'text', 'text', 'preview-' || s)),
        timestamp '2026-01-01' - s * interval '1 second'
      FROM threads t CROSS JOIN generate_series(1, 2000) s
      WHERE t."workspaceId" = ${workspaceId} AND t.id <> ${`${workspaceId}-thread-8`}
    `;
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: workspaceId } });
    await prisma.$disconnect();
    await pool.end();
  });

  it("matches nested latest-message results and bounds transferred rows as history grows", async () => {
    queries.length = 0;
    const before = performance.now();
    const legacy = await prisma.thread.findMany({
      where: { workspaceId },
      include: { messages: { orderBy: { seq: "desc" }, take: 1 } },
    });
    const legacyMs = performance.now() - before;
    const legacyQuery = queries.find((q) => q.query.includes('"messages"'))!;
    expect(legacyQuery).toBeDefined();
    const transferred = await pool.query(legacyQuery.query, JSON.parse(legacyQuery.params));
    queries.length = 0;
    const start = performance.now();
    const latest = await latestMessageBlocks(prisma, actor, threadIds);
    const boundedMs = performance.now() - start;
    const boundedQuery = queries.find((q) => q.query.includes("LATERAL"))!;
    const bounded = await pool.query(boundedQuery.query, JSON.parse(boundedQuery.params));
    for (const thread of legacy) expect(latest.get(thread.id)).toEqual(thread.messages[0]?.blocks);
    expect(transferred.rowCount).toBe(20_000);
    expect(bounded.rowCount).toBe(10);
    const plan = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${boundedQuery.query}`,
      JSON.parse(boundedQuery.params),
    );
    console.info(
      JSON.stringify(
        {
          fixtureMessages: 20_000,
          legacyRows: transferred.rowCount,
          boundedRows: bounded.rowCount,
          legacyMs,
          boundedMs,
          plan: plan.rows[0],
        },
        null,
        2,
      ),
    );
  });

  it("preserves sidebar preview, empty threads, archived selection, pinning and group members", async () => {
    const bots = await createRepos(prisma).listBots(actor);
    expect(bots).toHaveLength(9);
    expect(bots[0]).toMatchObject({
      name: "Bot 3",
      pinned: true,
      unread: true,
      preview: "preview-2000",
      status: "idle",
    });
    expect(bots.find((bot) => bot.name === "Bot 8")?.preview).toBe("");
    expect(
      (await createRepos(prisma).listBots(actor, { archived: true })).map((bot) => bot.name),
    ).toEqual(["Bot 9"]);
    const groups = await createGroupRepos(prisma).listGroups(actor);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      name: "Group",
      preview: "preview-2000",
      members: [{ name: "Bot 0" }, { name: "Bot 1" }],
    });
  });

  it("does not return blocks for another user or workspace, and skips an empty request", async () => {
    expect(await latestMessageBlocks(prisma, { ...actor, userId: "other" }, threadIds)).toEqual(
      new Map(),
    );
    expect(
      await latestMessageBlocks(prisma, { ...actor, workspaceId: "other" }, threadIds),
    ).toEqual(new Map());
    queries.length = 0;
    expect(await latestMessageBlocks(prisma, actor, [])).toEqual(new Map());
    expect(queries).toEqual([]);
  });
});
