# Attachment search batching

Base: `14bc82178b593f3575bbc023a441b9de4cd85e66`. PostgreSQL 16, Prisma 7.9.1, Node 24.19.0, synthetic local fixtures.

Attachment-name hits still use the original candidate queries and ordering, bot/group ownership filters, JSON-text ILIKE matching and newest-createdAt reference selection. A parameterized VALUES/lateral query resolves up to 25 candidates per source in one round trip. Results are consumed in candidate order. Later sources are skipped after the content budget fills. Conversation/content priority and dedupe keys are unchanged.

The PostgreSQL test creates 25 bot artifacts and 25 group artifacts with two references each. All 25 returned hits were byte-for-byte equal to the original source's ordered response. Original: 57 Prisma operations, including 52 raw queries. Replacement: 4 Prisma operations, including 1 raw query. Prisma includes can generate additional SQL statements; these counts are Prisma operations, not total database statements. Observed local duration: 111.8 ms original, 15.4 ms replacement (one warm local sample; no timing assertion).

Reproduce on a migrated disposable local database:

```sh
set -e
trap 'rm -f apps/api/src/.baseline-search.ts' EXIT
git show 14bc82178b593f3575bbc023a441b9de4cd85e66:apps/api/src/search.ts > apps/api/src/.baseline-search.ts
SEARCH_BASELINE=1 VERIFY_DATABASE=1 DATABASE_URL=postgres://rakazo:rakazo@127.0.0.1:5433/rakazo \
  pnpm exec vitest run apps/api/src/search.postgres.test.ts --disableConsoleIntercept --reporter=verbose
```

The baseline file is temporary and must not be committed. Ordinary PostgreSQL integration runs exercise the replacement without it. Offline tests cover blank input, candidate ordering despite reversed batch results, unreferenced artifacts, saturation, source priority, empty group names, text/link dedupe and scoped candidate predicates. PostgreSQL tests also check ownership/workspace isolation and group attachment targets.

JSON-text ILIKE still scans message content for each candidate within the database. This change reduces round trips and avoids unused source searches; it does not claim to remove that scan cost. No index or migration is proposed. Case/wildcard semantics and existing unspecified ordering of tied createdAt values remain unchanged.
