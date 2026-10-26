// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageBubble } from "../components/thread-message";
import type { MobileMessage } from "./api";

const { markdown, rpc } = vi.hoisted(() => ({ markdown: vi.fn(), rpc: vi.fn() }));
vi.mock("@rakazo/chat-ui/native", () => ({
  ChatMarkdown: ({ children }: { children: string }) => {
    markdown(children);
    return createElement("span", null, children);
  },
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children: ReactNode }) => createElement("span", null, children),
  TextInput: "input",
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel?: string;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick: onPress, "aria-label": accessibilityLabel, disabled },
      children,
    ),
  Alert: { alert: vi.fn() },
}));
vi.mock("./api", () => ({
  blockText: (message: MobileMessage) =>
    message.blocks.flatMap((block) => ("text" in block ? [block.text] : [])).join(""),
  rpc,
}));
vi.mock("./artifact-open", () => ({ openMobileArtifact: vi.fn() }));
vi.mock("./voice", () => ({ playMpeg: vi.fn(), speakUtterance: vi.fn() }));
vi.mock("../components/AppConnectCard", () => ({ AppConnectCard: () => null }));
vi.mock("../components/AskActions", () => ({ AskActions: () => null }));

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.clearAllMocks();
});

function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div");
  root = createRoot(container);
}
const message: MobileMessage = {
  id: "message-1",
  role: "bot",
  botId: "bot-1",
  runId: "run-1",
  seq: 1,
  blocks: [{ kind: "text", text: "Answer" }],
};
const props = {
  botId: "bot-1",
  message,
  canAnswer: false,
  onAnswer: vi.fn(async () => undefined),
  onOpenBot: vi.fn(),
  onPreviewMarkdown: vi.fn(),
};

describe("mobile transcript memoisation", () => {
  it("skips markdown for 20 composer renders across 100 unchanged rows, then renders an updated row", async () => {
    mount();
    const rows = Array.from({ length: 100 }, (_, i) => ({ ...message, id: `m-${i}` }));
    const render = (draft: string) =>
      createElement(
        "div",
        { "data-draft": draft },
        rows.map((row) => createElement(MessageBubble, { ...props, key: row.id, message: row })),
      );
    await act(async () => root!.render(render("")));
    expect(markdown).toHaveBeenCalledTimes(100);
    for (let i = 1; i <= 20; i++) await act(async () => root!.render(render("x".repeat(i))));
    expect(markdown).toHaveBeenCalledTimes(100);
    rows[42] = { ...rows[42]!, blocks: [{ kind: "text", text: "Updated answer" }] };
    await act(async () => root!.render(render("next")));
    expect(markdown).toHaveBeenCalledTimes(101);
    expect(container.textContent).toContain("Updated answer");
  });

  it("updates reply previews and the voice target", async () => {
    mount();
    const reply = {
      ...message,
      id: "parent",
      blocks: [{ kind: "text" as const, text: "Reply preview" }],
    };
    await act(async () => root!.render(createElement(MessageBubble, props)));
    await act(async () =>
      root!.render(
        createElement(MessageBubble, {
          ...props,
          botId: "fallback",
          message: { ...message, botId: undefined },
          replyPreview: reply,
          members: [{ botId: "bot-1", name: "Research", color: "#000" }],
        }),
      ),
    );
    expect(container.textContent).toContain("Reply preview");
    rpc.mockResolvedValue({ ready: true, utterances: [] });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Speak message"]')!.click(),
    );
    expect(rpc).toHaveBeenCalledWith("voice/prepare", { text: "Answer", botId: "fallback" });
  });
  it("updates member names and answer eligibility", async () => {
    mount();
    await act(async () =>
      root!.render(
        createElement(MessageBubble, {
          ...props,
          members: [{ botId: "bot-1", name: "Old", color: "#000" }],
        }),
      ),
    );
    await act(async () =>
      root!.render(
        createElement(MessageBubble, {
          ...props,
          members: [{ botId: "bot-1", name: "New", color: "#000" }],
        }),
      ),
    );
    expect(container.textContent).toContain("New");
    expect(container.textContent).not.toContain("Old");
    const ask: MobileMessage = {
      ...message,
      blocks: [{ kind: "ask", text: "Continue?", status: "pending" }],
    };
    await act(async () => root!.render(createElement(MessageBubble, { ...props, message: ask })));
    expect(container.textContent).toContain("Waiting for this bot");
    await act(async () =>
      root!.render(createElement(MessageBubble, { ...props, message: ask, canAnswer: true })),
    );
    expect(container.textContent).toContain("Send answer");
  });
});
