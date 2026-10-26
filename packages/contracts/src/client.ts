/** Constants and pure UI helpers; this entry point does not initialise runtime schemas. */
import type { CreateBotInput } from "./domain.js";

export * from "./attachments.js";
export * from "./openai-compatible-ui.js";

export const GROUP_MEMBER_MIN = 2;
export const GROUP_MEMBER_MAX = 6;

export const BOT_NAME_MAX_LENGTH = 80;
export const BOT_TITLE_MAX_LENGTH = 500;
export const BOT_DESCRIPTION_MAX_LENGTH = 4000;
export const BOT_INSTRUCTIONS_MAX_LENGTH = 20000;

export function normalizeCreateBotProfile(
  input: Pick<CreateBotInput, "name" | "title" | "description">,
) {
  const description = input.description.trim();
  return {
    name: input.name.trim().slice(0, BOT_NAME_MAX_LENGTH),
    title: input.title.trim().slice(0, BOT_TITLE_MAX_LENGTH),
    description: description.slice(0, BOT_DESCRIPTION_MAX_LENGTH),
    instructions: description.slice(0, BOT_INSTRUCTIONS_MAX_LENGTH),
  };
}

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

export const MAX_CHART_DATA_ROWS = 5_000;
