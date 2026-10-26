# Recent completed runs: index assessment

The benchmark calls `listWorkspaceRuns(prisma, actor, "recent")` and captures its actual Prisma SELECT and bound parameters. That SELECT scopes workspace/user, joins nonarchived bots, filters completed/failed/cancelled, orders completedAt DESC, updatedAt DESC, id DESC, and limits 20. The migration leaves that query and every DTO unchanged.

Fixture: local PostgreSQL 16, Prisma 7.9.1, Node 24.19.0; 400,000 runs across eight workspaces, two users/workspace and 20 bots/workspace. 20% of bots are archived; runs are 75% completed, 10% failed, 10% cancelled, 5% running. Terminal completedAt includes NULLs; timestamps tie deliberately. The target user has 25,000 runs. No production data or access.

Seven warm EXPLAIN ANALYZE/BUFFERS/WAL samples per candidate (median SQL execution; two warmups):

| Candidate | Median ms | Shared hit blocks | New index bytes |
| --- | ---: | ---: | ---: |
| Existing indexes | 40.315 | 3,590 | 0 |
| Scope + complete order, all statuses | 0.177 | see results JSON | 36,421,632 |
| Scope + complete order, terminal-only | 0.063 | 27 | 34,603,008 |
| Scope + status + complete order | 35.932 | 3,590 | 40,214,528 |

Baseline reads 50,000 workspace index entries, filters to 23,750 terminal runs for the user, joins to 14,250 nonarchived rows, then performs a top-N sort. The chosen partial index reads 32 entries, joins to 20 eligible runs and needs no sort. Status before completedAt cannot supply the combined three-status order, so it still sorts.

A separate nine-sample stress case makes all archived-bot runs and active runs a newest-first NULL-completion prefix. Median drops 38.793 -> 6.234 ms; index scan visits 9,520 entries before 20 eligible runs, versus scanning/sorting the workspace history. Archived-heavy histories can still cost more; the index cannot remove the bot join. Complete ordered DTOs match before/after every candidate in both scenarios.

Write cost: five samples of 1,000 new runs, each inserted queued, transitioned leased/running through twelve progress/checkpoint updates, then completed. Every phase asserts 1,000 affected rows with EXPLAIN ANALYZE RETURNING. Each transaction is rolled back and VACUUM ANALYZE runs between samples. Median summed SQL execution/WAL:

| Candidate | Lifecycle ms | WAL bytes |
| --- | ---: | ---: |
| Existing indexes | 925.158 | 12,880,769 |
| Terminal-only | 907.532 | 13,067,842 |
| All statuses | 942.591 | 15,421,040 |

The terminal index adds ~1.45% WAL, with no slowdown established by these noisy local timing samples. It omits active entries, so only terminal insertion/transition maintains its tuples. It adds ~34.6 MB for 380,000 terminal rows (~91 bytes/entry), about 28% of the fixture's preexisting run-index storage. Terminal-row updates still maintain the index. The full alternative adds ~19.7% WAL in this lifecycle. These are controlled synthetic measurements, not production latency/throughput guarantees.

The migration uses CREATE INDEX CONCURRENTLY, preserving writes during creation; no existing index is removed. Local deploy succeeded and repeat deploy had no pending migrations; pg_index reports indisvalid/indisready true. Failed concurrent builds can leave an invalid index: inspect and remove it before resolving/retrying a failed migration, using the repository's normal maintenance process. Do not hide a failure with IF NOT EXISTS. PostgreSQL generic prepared plans may not prove a parameterized partial predicate; current createDb uses PrismaPg without named statement caching. No planner settings are changed.

Reproduce in a fresh disposable **local** database (the script enforces its database name and loopback host):

```sh
docker exec rakazo-dev-postgres createdb -U rakazo rakazo_runs_perf
export DATABASE_URL=postgres://rakazo:rakazo@127.0.0.1:5433/rakazo_runs_perf
pnpm db:migrate
pnpm exec tsx packages/db/bench/recent-runs.ts > /tmp/recent-runs-results.jsonl
docker exec rakazo-dev-postgres dropdb -U rakazo rakazo_runs_perf
```

The benchmark drops the proposed index in that disposable database for a true baseline, creates/removes candidate indexes, and emits full EXPLAIN JSON. Committed results JSON retains relevant plan nodes/counters, bound query, storage and all write samples. Optional REUSE_RUNS_FIXTURE=1 and WRITES_ONLY=1 support assessment iterations; use the fresh default run for reproduction. Normal integration tests separately verify NULL-first ordering, ties, all terminal statuses, scope, archived exclusions, 20-row limit and unchanged active results on the migrated schema.

Dependency: shared Expo prerequisite PR #16 at 7f95a6e57becf7b0e0496dfa52afc5973e5ee87d must land first. No dependency on sidebar/search/auth performance changes.
