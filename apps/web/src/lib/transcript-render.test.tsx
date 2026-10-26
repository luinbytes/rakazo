// @vitest-environment jsdom
import { act, type ComponentProps, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Transcript } from "../pages/Shell";

const { markdown } = vi.hoisted(() => ({ markdown: vi.fn() }));
vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => {
    markdown(children);
    return <span>{children}</span>;
  },
}));

it("keeps unchanged transcript rows memoised when another row streams or speech changes", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLElement.prototype.scrollTo = vi.fn();
  const container = document.createElement("div");
  const root = createRoot(container);
  const onSpeak = vi.fn();
  const messages = Array.from({ length: 100 }, (_, i) => ({
    id: `m-${i}`,
    threadId: "thread",
    seq: i,
    role: "bot" as const,
    botId: "bot",
    runId: "run",
    blocks: [{ kind: "text" as const, text: `Answer ${i}` }],
    createdAt: "2026-01-01T00:00:00Z",
  }));
  const props: ComponentProps<typeof Transcript> = {
    scrollRef: createRef(),
    artifactTarget: { botId: "bot" },
    messages,
    olderCursor: null,
    loadingOlder: false,
    answerableAskMessageId: null,
    running: false,
    workingBots: [],
    onLoadOlder: vi.fn(),
    onOpenBot: vi.fn(),
    onAnswer: vi.fn(),
    onReply: vi.fn(),
    onJumpToMessage: vi.fn(),
    onOpenPeerMessages: vi.fn(),
    peerBot: () => undefined,
    onRefresh: vi.fn(),
    onBotChanged: vi.fn(),
    onAddRoutine: vi.fn(),
    voiceReady: true,
    speakingMessageId: null,
    onSpeak,
  };
  try {
    await act(async () => root.render(<Transcript {...props} />));
    expect(markdown).toHaveBeenCalledTimes(100);
    const updated = [...messages];
    updated[42] = { ...updated[42]!, blocks: [{ kind: "text", text: "Stream updated" }] };
    await act(async () => root.render(<Transcript {...props} messages={updated} />));
    expect(markdown).toHaveBeenCalledTimes(101);
    await act(async () =>
      root.render(<Transcript {...props} messages={updated} speakingMessageId="m-42" />),
    );
    expect(markdown).toHaveBeenCalledTimes(102);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Stop speaking"]')!.click(),
    );
    expect(onSpeak).toHaveBeenCalledWith(updated[42]);
  } finally {
    await act(async () => root.unmount());
  }
});
