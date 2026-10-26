# Sidebar latest-message retrieval

Base: `14bc82178b593f3575bbc023a441b9de4cd85e66`. Prisma 7.9.1, PostgreSQL 16, Node 24.19.0. Synthetic local fixtures only.

`listBots` and `listGroups` now fetch latest blocks with a lateral `ORDER BY seq DESC LIMIT 1` lookup per owned thread. Bot/group ordering and mapping stay unchanged. Detail and mutation group queries retain their existing full record shape. No migration or new index.

Reproduce against a migrated disposable local database (never production):

```sh
VERIFY_DATABASE=1 DATABASE_URL=postgres://rakazo:rakazo@127.0.0.1:5433/rakazo \
  pnpm exec vitest run packages/db/src/sidebar.postgres.test.ts --disableConsoleIntercept --reporter=verbose
```

The test creates and removes its own organization with 11 threads (one empty), 20,000 messages, an archived bot and a group. Message creation times run opposite sequence order to catch accidental timestamp ordering. It compares the new result to Prisma's original nested `take: 1`, replays captured SQL to count transferred rows, and prints `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` for the new query.

Observed local run: original message SQL transferred 20,000 rows; replacement transferred 10. End-to-end lookup was 123.9 ms versus 4.1 ms (single warm local sample; timings vary). The replacement plan used a backward scan of `messages_threadId_seq_key` beneath `Limit`, 11 loops, at most one row per loop; total execution 0.146 ms, 45 shared hit blocks, no reads or temp writes. The extra bounded query removes history-dependent transfer/materialization; it does add a round trip for nonempty sidebars. Empty lists skip it.

Regression checks cover matching blocks, empty threads, archive selection, pinning/unread, group member order, and workspace/user isolation. Active-run nested selections are unchanged and remain a separate possible optimization. No claim is made about production latency or index needs for recent runs.
