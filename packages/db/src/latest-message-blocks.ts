import type { Actor } from "@rakazo/contracts";
import { Prisma, type PrismaClient } from "./client.js";

/** Fetch one indexed message per owned thread, without Prisma's nested-take overfetch. */
export async function latestMessageBlocks(
  prisma: PrismaClient,
  actor: Actor,
  threadIds: string[],
): Promise<Map<string, Prisma.JsonValue>> {
  if (!threadIds.length) return new Map();
  const rows = await prisma.$queryRaw<Array<{ threadId: string; blocks: Prisma.JsonValue }>>(
    Prisma.sql`
      SELECT t.id AS "threadId", latest.blocks
      FROM threads t
      CROSS JOIN LATERAL (
        SELECT m.blocks FROM messages m
        WHERE m."threadId" = t.id
        ORDER BY m.seq DESC
        LIMIT 1
      ) latest
      WHERE t.id IN (${Prisma.join(threadIds)})
        AND t."workspaceId" = ${actor.workspaceId}
        AND t."userId" = ${actor.userId}
    `,
  );
  return new Map(rows.map((row) => [row.threadId, row.blocks]));
}
