import type { Actor, MessageBlock, SearchHit } from "@rakazo/contracts";
import { extractLinksFromText, matchesSearchQuery, snippetAroundMatch } from "@rakazo/core";
import { Prisma, type PrismaClient } from "@rakazo/db";

const SEARCH_LIMIT = 25;
/** Cap name matches so content hits (messages/files/links/routines) keep most of the budget. */
const CONVERSATION_HIT_LIMIT = 5;

export async function queryWorkspaceSearch(
  prisma: PrismaClient,
  actor: Actor,
  q: string,
): Promise<SearchHit[]> {
  const query = q.trim();
  if (!query) return [];

  const conversationHits: SearchHit[] = [];
  const contentHits: SearchHit[] = [];
  const seen = new Set<string>();

  function pushInto(bucket: SearchHit[], hit: SearchHit, limit: number) {
    const key = [
      hit.kind,
      hit.botId ?? "",
      hit.groupId ?? "",
      hit.messageId ?? "",
      hit.artifactId ?? "",
      hit.routineId ?? "",
      hit.url ?? "",
    ].join(":");
    if (seen.has(key) || bucket.length >= limit) return;
    seen.add(key);
    bucket.push(hit);
  }

  const bots = await prisma.bot.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      archivedAt: null,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { title: { contains: query, mode: "insensitive" } },
        { description: { contains: query, mode: "insensitive" } },
      ],
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const bot of bots) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        botId: bot.id,
        botName: bot.name,
        title: bot.name,
        snippet: bot.title || bot.description || bot.name,
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  const groups = await prisma.chatGroup.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      name: { contains: query, mode: "insensitive" },
    },
    take: CONVERSATION_HIT_LIMIT,
  });
  for (const group of groups) {
    pushInto(
      conversationHits,
      {
        kind: "conversation",
        groupId: group.id,
        groupName: group.name,
        title: group.name,
        snippet: group.name,
      },
      CONVERSATION_HIT_LIMIT * 2,
    );
  }

  const contentBudget = Math.max(0, SEARCH_LIMIT - conversationHits.length);

  const artifacts = await prisma.artifact.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      groupId: null,
      botId: { not: null },
      name: { contains: query, mode: "insensitive" },
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const artifactsMessages = await findArtifactMessages(
    prisma,
    actor,
    artifacts.flatMap((artifact) =>
      artifact.botId && artifact.bot ? [{ id: artifact.id, destinationId: artifact.botId }] : [],
    ),
    "botId",
  );
  for (const artifact of artifacts) {
    if (contentHits.length >= contentBudget) break;
    if (!artifact.botId || !artifact.bot) continue;
    const message = artifactsMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        botId: artifact.botId,
        botName: artifact.bot.name,
        title: artifact.name,
        snippet: `${artifact.mimeType} · ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  if (contentHits.length >= contentBudget) return [...conversationHits, ...contentHits];

  const groupArtifacts = await prisma.artifact.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      groupId: { not: null },
      name: { contains: query, mode: "insensitive" },
    },
    include: { group: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  const groupArtifactsMessages = await findArtifactMessages(
    prisma,
    actor,
    groupArtifacts.flatMap((artifact) =>
      artifact.groupId && artifact.group
        ? [{ id: artifact.id, destinationId: artifact.groupId }]
        : [],
    ),
    "groupId",
  );
  for (const artifact of groupArtifacts) {
    if (contentHits.length >= contentBudget) break;
    if (!artifact.groupId || !artifact.group) continue;
    const message = groupArtifactsMessages.get(artifact.id);
    if (!message) continue;
    pushInto(
      contentHits,
      {
        kind: "file",
        groupId: artifact.groupId,
        groupName: artifact.group.name,
        title: artifact.name,
        snippet: `${artifact.mimeType} · ${artifact.size} bytes`,
        artifactId: artifact.id,
        messageId: message.id,
        seq: message.seq,
      },
      contentBudget,
    );
  }

  if (contentHits.length >= contentBudget) return [...conversationHits, ...contentHits];

  const routines = await prisma.routine.findMany({
    where: {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { prompt: { contains: query, mode: "insensitive" } },
      ],
      bot: { archivedAt: null },
    },
    include: { bot: { select: { name: true } } },
    take: SEARCH_LIMIT,
  });
  for (const routine of routines) {
    pushInto(
      contentHits,
      {
        kind: "routine",
        botId: routine.botId,
        botName: routine.bot.name,
        title: routine.name,
        snippet: snippetAroundMatch(routine.prompt, query),
        routineId: routine.id,
      },
      contentBudget,
    );
  }

  if (contentHits.length >= contentBudget) return [...conversationHits, ...contentHits];

  const pattern = `%${query}%`;
  const messageRows = await prisma.$queryRaw<
    Array<{
      id: string;
      threadId: string;
      seq: number;
      blocks: Prisma.JsonValue;
      botId: string;
      botName: string;
    }>
  >`
    SELECT m.id, m."threadId", m.seq, m.blocks, b.id AS "botId", b.name AS "botName"
    FROM messages m
    INNER JOIN threads t ON t.id = m."threadId"
    INNER JOIN bots b ON b.id = t."botId"
    WHERE t."workspaceId" = ${actor.workspaceId}
      AND t."userId" = ${actor.userId}
      AND b."archivedAt" IS NULL
      AND m.blocks::text ILIKE ${pattern}
    ORDER BY m."createdAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `;

  for (const row of messageRows) {
    pushMessageHits(row.blocks as MessageBlock[], {
      botId: row.botId,
      botName: row.botName,
      messageId: row.id,
      seq: row.seq,
      query,
      push: (hit) => pushInto(contentHits, hit, contentBudget),
    });
  }

  if (contentHits.length >= contentBudget) return [...conversationHits, ...contentHits];

  const groupMessageRows = await prisma.$queryRaw<
    Array<{
      id: string;
      threadId: string;
      seq: number;
      blocks: Prisma.JsonValue;
      groupId: string;
      groupName: string;
    }>
  >`
    SELECT m.id, m."threadId", m.seq, m.blocks, g.id AS "groupId", g.name AS "groupName"
    FROM messages m
    INNER JOIN threads t ON t.id = m."threadId"
    INNER JOIN chat_groups g ON g.id = t."groupId"
    WHERE t."workspaceId" = ${actor.workspaceId}
      AND t."userId" = ${actor.userId}
      AND t."groupId" IS NOT NULL
      AND m.blocks::text ILIKE ${pattern}
    ORDER BY m."createdAt" DESC
    LIMIT ${SEARCH_LIMIT}
  `;

  for (const row of groupMessageRows) {
    pushMessageHits(row.blocks as MessageBlock[], {
      groupId: row.groupId,
      groupName: row.groupName,
      messageId: row.id,
      seq: row.seq,
      query,
      push: (hit) => pushInto(contentHits, hit, contentBudget),
    });
  }

  return [...conversationHits, ...contentHits].slice(0, SEARCH_LIMIT);
}

/** One round trip for each bounded candidate batch; keep the original ILIKE/createdAt semantics. */
async function findArtifactMessages(
  prisma: PrismaClient,
  actor: Actor,
  artifacts: Array<{ id: string; destinationId: string }>,
  destination: "botId" | "groupId",
): Promise<Map<string, { id: string; seq: number }>> {
  if (!artifacts.length) return new Map();
  const destinationColumn =
    destination === "botId" ? Prisma.sql`t."botId"` : Prisma.sql`t."groupId"`;
  const rows = await prisma.$queryRaw<Array<{ artifactId: string; id: string; seq: number }>>(
    Prisma.sql`
      SELECT a.id AS "artifactId", latest.id, latest.seq
      FROM (VALUES ${Prisma.join(artifacts.map((artifact) => Prisma.sql`(${artifact.id}::text, ${artifact.destinationId}::text)`))}) AS a(id, "destinationId")
      CROSS JOIN LATERAL (
        SELECT m.id, m.seq
        FROM messages m
        INNER JOIN threads t ON t.id = m."threadId"
        WHERE t."workspaceId" = ${actor.workspaceId}
          AND t."userId" = ${actor.userId}
          AND ${destinationColumn} = a."destinationId"
          AND m.blocks::text ILIKE ('%' || a.id || '%')
        ORDER BY m."createdAt" DESC
        LIMIT 1
      ) latest
    `,
  );
  return new Map(rows.map((row) => [row.artifactId, { id: row.id, seq: row.seq }]));
}

function pushMessageHits(
  blocks: MessageBlock[],
  ctx: {
    botId?: string;
    botName?: string;
    groupId?: string;
    groupName?: string;
    messageId: string;
    seq: number;
    query: string;
    push: (hit: SearchHit) => void;
  },
) {
  // Discriminate on groupId (not name): empty group names must still target the group.
  const destination = ctx.groupId
    ? { groupId: ctx.groupId, groupName: ctx.groupName ?? "" }
    : { botId: ctx.botId!, botName: ctx.botName! };
  const title = ctx.groupId ? (ctx.groupName ?? "") : (ctx.botName ?? "");
  let messageHit = false;
  for (const block of blocks) {
    if (block.kind !== "text") continue;
    const text = block.text;
    if (matchesSearchQuery(ctx.query, text)) {
      ctx.push({
        kind: "message",
        ...destination,
        title,
        snippet: snippetAroundMatch(text, ctx.query),
        messageId: ctx.messageId,
        seq: ctx.seq,
      });
      messageHit = true;
    }
    for (const url of extractLinksFromText(text)) {
      if (matchesSearchQuery(ctx.query, url)) {
        ctx.push({
          kind: "link",
          ...destination,
          title: url,
          snippet: snippetAroundMatch(text, ctx.query),
          messageId: ctx.messageId,
          seq: ctx.seq,
          url,
        });
      }
    }
  }
  if (!messageHit && matchesSearchQuery(ctx.query, JSON.stringify(blocks))) {
    ctx.push({
      kind: "message",
      ...destination,
      title,
      snippet: ctx.query,
      messageId: ctx.messageId,
      seq: ctx.seq,
    });
  }
}
