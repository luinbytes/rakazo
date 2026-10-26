# Group/thread deadlock correction

The first hosted Postgres run for event-refresh PR #10 failed journey 54 at `journeys.test.ts:1575`: the snapshot returned an older failed run instead of the synthetic concurrent run. The exact same #10 head passed its targeted rerun. Baseline source at `14bc82178b593f3575bbc023a441b9de4cd85e66` reproduced the failure in three of 20 isolated repetitions of journey 54, using separate fake accounts per repetition and logging run states on assertion failure.

The failed run was the earlier handoff recipient. Its stored error was PostgreSQL `40P01`, raised at `appendEventInTransaction`'s thread update. The snapshot deliberately prioritizes a failed latest terminal run; its behavior was correct.

A captured PostgreSQL deadlock graph showed:

1. Group mutation holds the group row with `FOR UPDATE` and waits to update the thread.
2. Concurrent thread writer holds the thread and waits for the group's `FOR KEY SHARE` foreign-key check.

Use `FOR NO KEY UPDATE` in `lockOwnedGroup`. It still serializes group mutations, blocks concurrent deletion/key changes, and retains the exact workspace/user predicate. It permits foreign-key `KEY SHARE` checks on that stable group key. No retries, transaction splitting, weaker assertions or suppressed checks are needed. Other explicit lock modes are unchanged.

## Reproduce

```sh
pnpm test:integration
pnpm --filter @rakazo/db --filter @rakazo/testkit check
pnpm exec vitest run packages/db/src/groups.test.ts packages/db/src/events.test.ts
pnpm lint
```

`group-locks.test.ts` replays the observed lock cycle using two real concurrent PostgreSQL transactions and an explicit `KEY SHARE` query matching the foreign-key check in the server's deadlock graph. With the old `FOR UPDATE` mode, the first test fails because PostgreSQL aborts one transaction. With this correction, both transactions commit and both sequence increments persist. The other tests verify that another group mutation and a deletion still time out while the owner lock is held, and that other users/workspaces cannot acquire the owned lock.

Validation before stacking: all 20 stress repetitions passed after the lock-mode correction; the focused regression failed with the old mode (one failed/two passed) and passed with the corrected mode (three passed). The complete Postgres suite passed 68 tests. No change to the existing journey assertion or its asynchronous execution was committed.
