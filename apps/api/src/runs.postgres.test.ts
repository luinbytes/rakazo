import { randomUUID } from "node:crypto";
import { createDb } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listWorkspaceRuns } from "./runs.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
describe.skipIf(!enabled)("recent runs ordering and scope (PostgreSQL)", () => {
  const id = `runs-${randomUUID()}`;
  const actor = {
    workspaceId: id,
    userId: "fixture-user",
    email: "runs@example.test",
    isDeploymentOwner: false,
  };
  const { prisma, pool } = createDb(process.env.DATABASE_URL ?? "postgres://unused");
  const sameTime = new Date("2026-01-01T00:00:00Z");
  beforeAll(async () => {
    for (const workspaceId of [id, `${id}-other`])
      await prisma.organization.create({
        data: { id: workspaceId, name: "Run fixture", slug: workspaceId, createdAt: sameTime },
      });
    for (const suffix of ["active", "archived", "foreign"]) {
      const botId = `${id}-${suffix}`;
      const workspaceId = suffix === "foreign" ? `${id}-other` : id;
      await prisma.bot.create({
        data: {
          id: botId,
          workspaceId,
          userId: actor.userId,
          name: suffix,
          color: "#000",
          archivedAt: suffix === "archived" ? sameTime : null,
        },
      });
      await prisma.thread.create({ data: { id: botId, workspaceId, userId: actor.userId, botId } });
      await prisma.task.create({
        data: {
          id: botId,
          workspaceId,
          userId: actor.userId,
          botId,
          threadId: botId,
          status: "completed",
          prompt: "test\n prompt",
        },
      });
    }
    const shared = {
      workspaceId: id,
      userId: actor.userId,
      botId: `${id}-active`,
      threadId: `${id}-active`,
      taskId: `${id}-active`,
      trigger: "manual",
      updatedAt: sameTime,
      completedAt: sameTime,
    };
    await prisma.run.createMany({
      data: [
        ...Array.from({ length: 25 }, (_, i) => ({
          ...shared,
          id: `${id}-terminal-${String(i).padStart(2, "0")}`,
          status: ["completed", "failed", "cancelled"][i % 3]!,
          completedAt: i === 0 ? null : sameTime,
        })),
        { ...shared, id: `${id}-running`, status: "running", completedAt: null },
        { ...shared, id: `${id}-unknown`, status: "fixture-unknown" },
        {
          ...shared,
          id: `${id}-other-user`,
          userId: "other-user",
          status: "completed",
          completedAt: null,
        },
        {
          ...shared,
          id: `${id}-archived-run`,
          botId: `${id}-archived`,
          threadId: `${id}-archived`,
          taskId: `${id}-archived`,
          status: "completed",
          completedAt: null,
        },
        {
          ...shared,
          id: `${id}-foreign-run`,
          workspaceId: `${id}-other`,
          botId: `${id}-foreign`,
          threadId: `${id}-foreign`,
          taskId: `${id}-foreign`,
          status: "completed",
          completedAt: null,
        },
      ],
    });
  });
  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [id, `${id}-other`] } } });
    await prisma.$disconnect();
    await pool.end();
  });

  it("keeps NULL-first descending completion order, all terminal statuses, tie breaks, scope and limit", async () => {
    const rows = await listWorkspaceRuns(prisma, actor, "recent");
    expect(rows.map((r) => r.runId)).toEqual([
      `${id}-terminal-00`,
      ...Array.from({ length: 19 }, (_, i) => `${id}-terminal-${String(24 - i).padStart(2, "0")}`),
    ]);
    expect(new Set(rows.map((r) => r.status))).toEqual(
      new Set(["completed", "failed", "cancelled"]),
    );
    expect(rows.every((r) => r.promptSnippet === "test prompt")).toBe(true);
    expect(await listWorkspaceRuns(prisma, { ...actor, userId: "missing" }, "recent")).toEqual([]);
  });

  it("retains active-run results alongside the terminal-only index", async () => {
    const rows = await listWorkspaceRuns(prisma, actor, "active");
    expect(rows.map((r) => r.runId)).toEqual([`${id}-running`]);
  });
});
