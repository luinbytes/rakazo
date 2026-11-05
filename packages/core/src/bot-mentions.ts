import type { MessageBlock } from "@rakazo/contracts";
import { isToolActivityBlock } from "./tool-activity.js";

export type ChildBotBlock = Extract<MessageBlock, { kind: "child_bot" }>;

type MentionMessage = { id: string; role: string; botId?: string; blocks: MessageBlock[] };

function isProse(block: MessageBlock): boolean {
  return (block.kind === "text" || block.kind === "progress") && !isToolActivityBlock(block);
}

/**
 * A message that only announces new bots it created folds into the same bot's next reply, which names
 * them inline. Announcements with no later reply yet stay visible on their own.
 */
export function projectBotMentions<Message extends MentionMessage>(messages: readonly Message[]) {
  const mentions = new Map<string, ChildBotBlock[]>();
  // A folded announcement's id resolves to the reply that now shows it, so quotes can still jump.
  const foldedInto = new Map<string, string>();
  let pending: Message[] = [];
  let botId: string | undefined;
  for (const message of messages) {
    if (message.role !== "bot") {
      pending = [];
      continue;
    }
    if (message.botId !== botId) pending = [];
    botId = message.botId;
    if (message.blocks.some(isProse)) {
      if (pending.length) {
        const blocks = mentions.get(message.id) ?? [];
        for (const announcement of pending) {
          for (const block of announcement.blocks) blocks.push(block as ChildBotBlock);
          foldedInto.set(announcement.id, message.id);
        }
        mentions.set(message.id, blocks);
        pending = [];
      }
    } else if (
      message.blocks.length > 0 &&
      message.blocks.every((block) => block.kind === "child_bot" && block.status === "created")
    ) {
      pending.push(message);
    }
  }
  return {
    visibleMessages: messages.filter((message) => !foldedInto.has(message.id)),
    mentions,
    foldedInto,
  };
}
