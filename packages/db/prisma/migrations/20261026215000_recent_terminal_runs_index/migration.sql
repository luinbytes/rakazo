-- Match the recent activity query's scope and complete descending order.
-- Keep active runs out of this index so progress/checkpoint writes do not maintain it.
CREATE INDEX CONCURRENTLY "runs_recent_terminal_idx"
ON "runs" ("workspaceId", "userId", "completedAt" DESC, "updatedAt" DESC, "id" DESC)
WHERE "status" IN ('completed', 'failed', 'cancelled');
