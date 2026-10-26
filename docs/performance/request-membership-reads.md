# Request-local membership and me reads

Base: `14bc82178b593f3575bbc023a441b9de4cd85e66`. PostgreSQL 16, Prisma 7.9.1, Node 24.19.0. Synthetic fixtures only.

Authentication selects membership identifiers and the user fields needed by auth/me. It no longer fetches the organization record. Deployment settings are limited to ownership and me defaults. The RPC middleware passes that snapshot to me/bootstrap, avoiding a second user and deployment settings lookup. Every HTTP request resolves membership anew. Voice keeps the Actor-only wrapper. Preference/model mutation responses continue reading fresh state after writes.

The PostgreSQL benchmark compares original auth + original me router against the replacement. Identical complete me responses; Prisma operations 5 -> 3. Serialized Prisma-result bytes 9,574 -> 368 with an organization containing 8KB of fake metadata. This measures returned result objects, not wire bytes; metadata size affects the byte saving. Timings in one local sample were 65.0 ms -> 11.0 ms, with no timing thresholds or production claim. Better Auth session reads are outside this measurement and unchanged. Removing the organization include also removes its Prisma relation query; operation counts do not count extra SQL from includes.

Reproduce with a migrated disposable local database:

```sh
set -e
trap 'rm -f apps/api/src/.baseline-router.ts packages/db/src/.baseline-scope.ts' EXIT
git show 14bc82178b593f3575bbc023a441b9de4cd85e66:apps/api/src/router.ts > apps/api/src/.baseline-router.ts
git show 14bc82178b593f3575bbc023a441b9de4cd85e66:packages/db/src/scope.ts > packages/db/src/.baseline-scope.ts
AUTH_BASELINE=1 VERIFY_DATABASE=1 DATABASE_URL=postgres://rakazo:rakazo@127.0.0.1:5433/rakazo \
  pnpm exec vitest run apps/api/src/request-membership.postgres.test.ts --disableConsoleIntercept --reporter=verbose
```

The original-source files are temporary. Normal integration tests use only the replacement. Tests cover narrow selections, unchanged Actor shape, owner/settings changes, missing membership/settings, me/bootstrap reuse, fresh post-mutation state, changed profile on the next request and rejected revoked membership.

No session, membership or ownership value is cached globally. Snapshot reuse deliberately applies only to read-only me/bootstrap; existing mutation responses use fresh reads. No schema, authorization rule, session setting or public API contract changes.

The recent-completed-runs index hypothesis remains deferred: no representative run-history distribution and EXPLAIN evidence established an index benefit. No speculative migration is included.
