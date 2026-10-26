# Event refresh coalescing

Validated against main `14bc82178b593f3575bbc023a441b9de4cd85e66`. This branch is independent of the transcript memoisation PR.

Web/desktop bot and group subscriptions now share event-triggered sidebar and snapshot reads within each subscription. Mobile shares terminal-event snapshot reads. Each invalidation during an in-flight read requests a trailing read, including invalidations during that trailing read. There is no time-based debounce. Disposing a subscription drops queued work; existing response epoch, active-target, cursor, history and reconciliation guards remain in place. Native queued reads recheck history/jump state before starting.

Manual mutations, initial loads, reconnect reconciliation, archived-sidebar reads, polling and computer-status-only reads retain their existing paths. This scope avoids changing callers that await snapshots or explicitly include archived rows.

## Reproduce

```sh
pnpm exec vitest run packages/core/src/refresh-coalescer.test.ts
pnpm --filter @rakazo/core --filter @rakazo/web --filter @rakazo/mobile test
pnpm --filter @rakazo/core --filter @rakazo/web --filter @rakazo/mobile check
pnpm --filter @rakazo/web build
pnpm lint
```

The deterministic deferred-promise test sends one invalidation, starts its read, then sends 100 more invalidations before allowing responses. It asserts exactly two reads instead of the previous 101. Callers await the trailing read; another invalidation during that read produces a third, so later events cannot be lost. Tests also cover errors, retries, disposal, independent thread subscriptions and the completion microtask boundary. The existing cursor/history/reconciliation tests still run.

For the standard sidebar (bots, sections, groups), this reduces 303 RPCs to six in that controlled burst. A snapshot refresh has its own coalescer. Actual request counts depend on event timing; sparse events still refresh immediately, and continuous events can require more trailing reads. This is offline request-work evidence, not a production latency measurement.
