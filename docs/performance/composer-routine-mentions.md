# Composer routine mention loading

Validated against main `14bc82178b593f3575bbc023a441b9de4cd85e66`. Independent of the transcript, event-refresh and client-import changes.

Web/desktop and mobile previously issued one routine RPC per bot, plus two connector RPCs, whenever their existing bot-list effect refreshed suggestions. The new read-only `routines/listForMentions` endpoint loads active bot IDs for the authenticated workspace and user in one ownership query, then reuses the existing routine reader. It does not read another user's, another workspace's, or archived bots' routines. No global cache or new writes are involved. Existing suggestion effect dependencies, cancellation guards, connector fetching and bot-name enrichment remain in place.

The shared loader buckets the response in linear time and flattens it in client bot order. Each bot's existing routine order stays intact. A failed bot still leaves other bots' routines available. If the batch endpoint fails or an older server lacks it, both clients fall back to the original per-bot calls with partial-failure isolation.

## Reproduce

```sh
pnpm exec vitest run apps/api/src/routine-mentions.test.ts packages/core/src/routine-mentions.test.ts
pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/api --filter @rakazo/web --filter @rakazo/mobile test
pnpm --filter @rakazo/contracts --filter @rakazo/core --filter @rakazo/api --filter @rakazo/web --filter @rakazo/mobile check
pnpm --filter @rakazo/web build
pnpm lint
pnpm test:integration
```

The deterministic API test compares the actual legacy RPC results for 100 fake bots with the batched RPC results plus the shared client loader. Results and order match. It asserts 100 ownership queries before and one after. The normal path uses one routine RPC instead of 100; including the unchanged connector requests, total suggestion RPCs fall from 102 to three. Database reads fall from 200 to 101. Each bot's routine query remains unchanged, deliberately preserving its existing database order rather than introducing a new sort. This remaining database fan-out is a limit of this narrowly scoped change.

Other tests check authentication, the exact user/workspace/archive filter, no per-bot reads for excluded IDs, empty owned-bot lists, per-bot read failures, preservation of client order despite server order, filtering bots absent from the current client list, and legacy-server fallback.

These are offline request/query counts, not production latency measurements. Initial mention loading is not delayed until typing; that avoids changing first-use availability. There are no schema migrations or indexes.

Validation in the isolated cloud environment: 677 applicable unit tests and all 66 Postgres integration tests passed, including the new ownership/workspace/archive test and exhaustive unauthenticated-route coverage. Applicable TypeScript checks, Biome and the production web build passed. Expo compatibility was checked offline locally; hosted online compatibility is blocked by the shared baseline Expo patch-version drift, being handled in a separate PR.
