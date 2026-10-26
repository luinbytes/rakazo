import { createDb, IsolationError, lockOwnedGroup } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describeWithDatabase("owned group row lock compatibility", () => {
  let db: ReturnType<typeof createDb>;
  let groupId: string;
  let threadId: string;
  const workspaceId = `group-lock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const actor = { workspaceId, userId: "lock-test-user" };
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    await db.prisma.organization.create({
      data: {
        id: workspaceId,
        name: "Lock test",
        slug: workspaceId,
        createdAt: new Date(),
      },
    });
    const group = await db.prisma.chatGroup.create({
      data: {
        workspaceId,
        userId: actor.userId,
        name: "Lock test group",
        thread: { create: { workspaceId, userId: actor.userId } },
      },
      include: { thread: true },
    });
    groupId = group.id;
    threadId = group.thread!.id;
  });
  afterAll(async () => {
    if (!db) return;
    await db.prisma.organization.delete({ where: { id: workspaceId } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("allows a thread writer's group foreign-key check while a group mutation waits for that thread", async () => {
    const before = await db.prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
    const groupLocked = deferred();
    const threadLocked = deferred();
    const groupMutation = db.prisma.$transaction(async (tx) => {
      await lockOwnedGroup(tx, actor, groupId);
      groupLocked.resolve();
      await threadLocked.promise;
      await tx.thread.update({ where: { id: threadId }, data: { nextEventSeq: { increment: 1 } } });
    });
    await groupLocked.promise;
    const threadWrite = db.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM threads WHERE id = ${threadId} FOR UPDATE`;
      threadLocked.resolve();
      // Replay the foreign-key KEY SHARE check from the observed PostgreSQL deadlock graph.
      await tx.$queryRaw`SELECT id FROM chat_groups WHERE id = ${groupId} FOR KEY SHARE`;
      await tx.thread.update({
        where: { id: threadId },
        data: { nextMessageSeq: { increment: 1 } },
      });
    });
    const results = await Promise.allSettled([groupMutation, threadWrite]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    const after = await db.prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
    expect(after.nextEventSeq).toBe(before.nextEventSeq + 1);
    expect(after.nextMessageSeq).toBe(before.nextMessageSeq + 1);
  });

  it("still blocks another group mutation and deletion until the owner transaction commits", async () => {
    const locked = deferred();
    const release = deferred();
    const owner = db.prisma.$transaction(async (tx) => {
      await lockOwnedGroup(tx, actor, groupId);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    try {
      await expect(
        db.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
          await lockOwnedGroup(tx, actor, groupId);
        }),
      ).rejects.toThrow(/lock timeout/);
      await expect(
        db.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '100ms'`;
          await tx.chatGroup.delete({ where: { id: groupId } });
        }),
      ).rejects.toThrow(/lock timeout/);
    } finally {
      release.resolve();
      await owner;
    }
    expect(await db.prisma.chatGroup.findUnique({ where: { id: groupId } })).not.toBeNull();
  });

  it("retains workspace and user ownership isolation", async () => {
    for (const other of [
      { ...actor, userId: "other-user" },
      { ...actor, workspaceId: "other-workspace" },
    ]) {
      await expect(
        db.prisma.$transaction((tx) => lockOwnedGroup(tx, other, groupId)),
      ).rejects.toThrow(IsolationError);
    }
  });
});
