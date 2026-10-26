/** Preserve composer bot ordering and tolerate servers predating the batch endpoint. */
export async function loadRoutineMentions<T extends { botId: string }>(
  botIds: readonly string[],
  readBatch: () => Promise<T[]>,
  readBot: (botId: string) => Promise<T[]>,
): Promise<T[]> {
  let rows: T[];
  try {
    rows = await readBatch();
  } catch {
    // Same per-bot failure isolation as the original clients.
    return (await Promise.all(botIds.map((id) => readBot(id).catch(() => [])))).flat();
  }
  const byBot = new Map<string, T[]>();
  for (const row of rows) {
    const list = byBot.get(row.botId);
    if (list) list.push(row);
    else byBot.set(row.botId, [row]);
  }
  return botIds.flatMap((id) => byBot.get(id) ?? []);
}
