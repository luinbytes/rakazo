# Transcript rendering

Validated against main `14bc82178b593f3575bbc023a441b9de4cd85e66`.

Web/desktop: memoise active runs and working avatars; keep peer-message and speech callbacks stable across the transcript and message memo boundaries. Native: move the existing bubble unchanged into a memoised component, pass stable actions, and build the reply ID map once per message-array change. Scrolling, history loading, ordering, message keys, native row layout, approvals and speech targets are retained.

## Reproduce

Use Node 24 and the pinned pnpm 9.15.0 after `pnpm install --frozen-lockfile`:

```sh
pnpm exec vitest run apps/mobile/lib/thread-message.test.ts apps/web/src/lib/transcript-render.test.tsx
pnpm --filter @rakazo/mobile check
pnpm --filter @rakazo/web check
pnpm --filter @rakazo/web build
```

The deterministic render-count tests use 100 rows. Twenty native composer-only parent updates now leave Markdown renders at 100; the previous un-memoised bubble rendered all 100 rows for each update (2,100 including mount). Updating one row adds one render. On web, a single message update and a speech-state change each render one row instead of all 100, with the same callback target. Tests also exercise reply preview changes, member names, voice fallback and ask eligibility.

Native reply resolution previously searched the whole array once per reply row on every composer update. It now builds a map in O(n) only when messages change and performs O(1) lookups per row; composer-only renders reuse the map. The ScrollView still mounts every row. This is a render-work reduction, not a device latency or memory measurement; long-history native device profiling remains useful.

No runtime packages were added. jsdom and the existing React DOM types are declared as test dependencies so the render tests do not depend on transitive tooling.
