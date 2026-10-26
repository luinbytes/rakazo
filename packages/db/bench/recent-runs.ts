import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { listWorkspaceRuns } from "../../../apps/api/src/runs.js";
import { PrismaClient } from "../src/client.js";

const url = process.env.DATABASE_URL;
if (
  !url ||
  new URL(url).pathname !== "/rakazo_runs_perf" ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname)
)
  throw new Error("Use only the disposable rakazo_runs_perf database");
const pool = new Pool({ connectionString: url });
const queries: Array<{ query: string; params: string }> = [];
const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
  log: [{ emit: "event", level: "query" }],
});
prisma.$on("query", (q) => queries.push(q));
const actor = {
  workspaceId: "runs-perf-w0",
  userId: "user-0",
  email: "perf@example.test",
  isDeploymentOwner: false,
};
const indexes = {
  full: 'CREATE INDEX runs_perf_candidate ON runs ("workspaceId", "userId", "completedAt" DESC, "updatedAt" DESC, id DESC)',
  partial: `CREATE INDEX runs_perf_candidate ON runs ("workspaceId", "userId", "completedAt" DESC, "updatedAt" DESC, id DESC) WHERE status IN ('completed','failed','cancelled')`,
  status:
    'CREATE INDEX runs_perf_candidate ON runs ("workspaceId", "userId", status, "completedAt" DESC, "updatedAt" DESC, id DESC)',
};
try {
  await pool.query("DROP INDEX IF EXISTS runs_perf_candidate");
  await pool.query("DROP INDEX IF EXISTS runs_recent_terminal_idx");
  if (process.env.REUSE_RUNS_FIXTURE !== "1") {
    await prisma.organization.deleteMany({ where: { id: { startsWith: "runs-perf-" } } });
    for (let w = 0; w < 8; w++) {
      const workspaceId = `runs-perf-w${w}`;
      await prisma.organization.create({
        data: { id: workspaceId, name: "Synthetic runs", slug: workspaceId, createdAt: new Date() },
      });
      for (let b = 0; b < 20; b++) {
        const id = `${workspaceId}-b${b}`;
        const userId = `user-${Math.floor(b / 10)}`;
        await prisma.bot.create({
          data: {
            id,
            workspaceId,
            userId,
            name: `Bot ${b}`,
            color: "#000",
            archivedAt: b < 4 ? new Date("2026-01-01") : null,
          },
        });
        await prisma.thread.create({ data: { id, workspaceId, userId, botId: id } });
        await prisma.task.create({
          data: {
            id,
            workspaceId,
            userId,
            botId: id,
            threadId: id,
            status: "completed",
            prompt: `Synthetic historical prompt ${"x".repeat(100)}`,
          },
        });
      }
    }
    const seeded = performance.now();
    await pool.query(`INSERT INTO runs (id, "workspaceId", "userId", "botId", "threadId", "taskId", status, trigger, "createdAt", "updatedAt", "completedAt")
    SELECT t.id || '-r' || lpad(s::text, 6, '0'), t."workspaceId", t."userId", t."botId", t.id, t.id,
      CASE WHEN s % 20 = 0 THEN 'running' WHEN s % 20 < 3 THEN 'failed' WHEN s % 20 < 5 THEN 'cancelled' ELSE 'completed' END,
      'manual', timestamp '2026-01-01' + s * interval '1 second',
      timestamp '2026-01-01' + (s / 3) * interval '1 second',
      CASE WHEN s % 20 = 0 OR s % 97 = 0 THEN NULL ELSE timestamp '2026-01-01' + (s / 3) * interval '1 second' END
    FROM tasks t CROSS JOIN generate_series(1,2500) s WHERE t."workspaceId" LIKE 'runs-perf-%'`);
    await pool.query("VACUUM ANALYZE runs");
    await pool.query("ANALYZE bots");
    console.log(JSON.stringify({ seedMs: performance.now() - seeded, rows: 400000 }));
  }
  const count = await pool.query("SELECT count(*)::int AS total FROM runs");
  assert.equal(count.rows[0].total, 400000, "Use exactly the documented synthetic history");
  queries.length = 0;
  const reference = await listWorkspaceRuns(prisma, actor, "recent");
  const query = queries.find((q) => q.query.includes('FROM "public"."runs"'));
  assert(query, "Capture actual Prisma runs SELECT");
  console.log(JSON.stringify({ sql: query.query, params: JSON.parse(query.params) }));
  const params = JSON.parse(query.params);
  async function measure(label: string) {
    for (let i = 0; i < 2; i++) await pool.query(query!.query, params);
    const plans = [];
    for (let i = 0; i < 7; i++) {
      const r = await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${query!.query}`,
        params,
      );
      plans.push(r.rows[0]["QUERY PLAN"][0]);
    }
    plans.sort((a, b) => a["Execution Time"] - b["Execution Time"]);
    const middle = plans[3];
    assert.deepEqual(await listWorkspaceRuns(prisma, actor, "recent"), reference);
    const size = await pool.query(
      "SELECT pg_relation_size('runs') AS table_bytes, pg_indexes_size('runs') AS index_bytes, COALESCE(pg_relation_size(to_regclass('runs_perf_candidate')), 0) AS candidate_bytes",
    );
    console.log(
      JSON.stringify({
        label,
        medianMs: middle["Execution Time"],
        size: size.rows[0],
        plan: middle,
      }),
    );
  }
  if (process.env.WRITES_ONLY !== "1") {
    await measure("baseline-mixed");
    for (const [name, ddl] of Object.entries(indexes)) {
      const start = performance.now();
      await pool.query(ddl);
      console.log(JSON.stringify({ candidate: name, buildMs: performance.now() - start }));
      await measure(`${name}-mixed`);
      await pool.query("DROP INDEX runs_perf_candidate");
    }
    // Stress a newest-first prefix of active and archived runs; NULL completedAt is deliberate.
    await pool.query(`UPDATE runs r SET "updatedAt" = timestamp '2026-02-01', "completedAt" = NULL
    WHERE r."workspaceId" = 'runs-perf-w0' AND (r.status = 'running' OR r."botId" IN (SELECT id FROM bots WHERE "workspaceId" = 'runs-perf-w0' AND "archivedAt" IS NOT NULL))`);
    await pool.query("VACUUM ANALYZE runs");
    // The reference order changes with fixture timestamps, so compare candidate response against the new baseline.
    const stressReference = await listWorkspaceRuns(prisma, actor, "recent");
    async function stress(label: string) {
      const plans = [];
      for (let i = 0; i < 9; i++) {
        const r = await pool.query(
          `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${query!.query}`,
          params,
        );
        plans.push(r.rows[0]["QUERY PLAN"][0]);
      }
      plans.sort((a, b) => a["Execution Time"] - b["Execution Time"]);
      assert.deepEqual(await listWorkspaceRuns(prisma, actor, "recent"), stressReference);
      console.log(JSON.stringify({ label, medianMs: plans[4]["Execution Time"], plan: plans[4] }));
    }
    await stress("baseline-prefix");
    await pool.query(indexes.partial);
    await stress("partial-prefix");
    await pool.query("DROP INDEX runs_perf_candidate");
  }

  // Roll each lifecycle back, then vacuum outside the transaction to remove benchmark bloat.
  // Every comparison starts with the same 400k-row history and five 1000-run lifecycle samples.
  async function writes(label: string) {
    const samples = [];
    for (let round = 0; round < 5; round++) {
      const client = await pool.connect();
      let executionMs = 0;
      let walBytes = 0;
      try {
        await client.query("BEGIN");
        const statements = [
          `INSERT INTO runs (id, "workspaceId", "userId", "botId", "threadId", "taskId", status, trigger, "createdAt", "updatedAt")
            SELECT 'write-' || s, 'runs-perf-w0', 'user-0', 'runs-perf-w0-b4', 'runs-perf-w0-b4', 'runs-perf-w0-b4', 'queued', 'manual', timestamp '2026-03-01', timestamp '2026-03-01' FROM generate_series(1,1000) s`,
          ...Array.from(
            { length: 12 },
            (_, i) =>
              `UPDATE runs SET status = '${i === 0 ? "leased" : "running"}', "updatedAt" = timestamp '2026-03-01' + interval '${i + 1} second', checkpoint = 'checkpoint-${i}' WHERE id = ANY (ARRAY(SELECT 'write-' || s FROM generate_series(1,1000) s))`,
          ),
          `UPDATE runs SET status = 'completed', "updatedAt" = timestamp '2026-03-02', "completedAt" = timestamp '2026-03-02' WHERE id = ANY (ARRAY(SELECT 'write-' || s FROM generate_series(1,1000) s))`,
        ];
        for (const sql of statements) {
          const r = await client.query(
            `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${sql} RETURNING id`,
          );
          const p = r.rows[0]["QUERY PLAN"][0];
          assert.equal(
            p.Plan["Actual Rows"],
            1000,
            "Every lifecycle phase must modify all 1000 fixture runs",
          );
          executionMs += p["Execution Time"];
          walBytes += p.Plan["WAL Bytes"] ?? 0;
        }
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      await pool.query("VACUUM ANALYZE runs");
      samples.push({ executionMs, walBytes });
    }
    samples.sort((a, b) => a.executionMs - b.executionMs);
    console.log(JSON.stringify({ label, writeLifecycleMedian: samples[2], samples }));
  }
  await writes("baseline-writes");
  await pool.query(indexes.partial);
  await writes("partial-writes");
  await pool.query("DROP INDEX runs_perf_candidate");
  await pool.query(indexes.full);
  await writes("full-writes");
  await pool.query("DROP INDEX runs_perf_candidate");
} finally {
  await prisma.$disconnect();
  await pool.end();
}
