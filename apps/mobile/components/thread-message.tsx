import { ChatMarkdown } from "@rakazo/chat-ui/native";
import type { MessageBlock } from "@rakazo/contracts";
import { isApprovalAskBlock, isSecretAskBlock } from "@rakazo/core";
import { memo, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { blockText, type MobileMessage, type MobileSnapshot, rpc } from "../lib/api";
import { type MobileArtifactTarget, openMobileArtifact } from "../lib/artifact-open";
import { playMpeg, speakUtterance } from "../lib/voice";
import { AppConnectCard } from "./AppConnectCard";
import { AskActions } from "./AskActions";
import type { MarkdownArtifactPreviewTarget } from "./markdown-artifact-preview";

function formatApprovalAnswer(answer: string | undefined): string {
  if (!answer) return "Answered";
  if (answer === "allow") return "Allowed once";
  if (answer === "always") return "Always allowed";
  if (answer === "deny") return "Denied";
  return `Answered: ${answer}`;
}

export function previewMessageText(message: MobileMessage): string {
  const text = message.blocks
    .flatMap((block) => (block.kind === "text" && block.text ? [block.text] : []))
    .join(" ")
    .trim();
  if (text) return text;
  if (message.blocks.some((block) => block.kind === "image" || block.kind === "file")) {
    return "Attachment";
  }
  return "Message";
}

function memberName(
  members: MobileSnapshot["members"] | undefined,
  botId: string | undefined,
): string | undefined {
  if (!botId || !members) return undefined;
  return members.find((member) => member.botId === botId)?.name;
}

async function speakMessage(botId: string, message: MobileMessage) {
  const text = blockText(message);
  if (!text.trim()) return;
  const prepared = await rpc<{ ready: boolean; utterances: string[] }>("voice/prepare", {
    text,
    botId,
  });
  if (!prepared.ready) throw new Error("Add a voice provider in Voice settings.");
  for (const utterance of prepared.utterances) {
    await playMpeg(await speakUtterance(utterance, { botId }));
  }
}

export const MessageBubble = memo(function MessageBubble({
  botId,
  groupId,
  message,
  members,
  replyPreview,
  canAnswer,
  onAnswer,
  onOpenBot,
  onPreviewMarkdown,
}: {
  botId: string;
  groupId?: string;
  message: MobileMessage;
  members?: MobileSnapshot["members"];
  replyPreview?: MobileMessage;
  canAnswer: boolean;
  onAnswer: (message: MobileMessage, answer: string) => Promise<void>;
  onOpenBot: (botId: string, name: string) => void;
  onPreviewMarkdown: (target: MarkdownArtifactPreviewTarget) => void;
}) {
  const answer = (answer: string) => onAnswer(message, answer);
  const onSpeak =
    message.role === "bot"
      ? () =>
          void speakMessage(message.botId ?? botId, message).catch((err) =>
            Alert.alert("Could not speak", err instanceof Error ? err.message : "Try again."),
          )
      : undefined;
  const [peerExpanded, setPeerExpanded] = useState(false);
  const artifactTarget: MobileArtifactTarget = groupId ? { groupId } : { botId };
  const cardBotId = message.botId ?? botId;
  const appConnectBlocks = message.blocks.filter(
    (block): block is Extract<MessageBlock, { kind: "app_connect" }> =>
      block.kind === "app_connect",
  );
  const ask = message.blocks.find(
    (block): block is Extract<MessageBlock, { kind: "ask" }> =>
      block.kind === "ask" && !isApprovalAskBlock(block),
  );
  if (ask) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <AskBlock ask={ask} canAnswer={canAnswer} onAnswer={answer} />
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
        ))}
      </View>
    );
  }
  const handoff = message.blocks.find((block) => block.kind === "handoff");
  if (handoff) {
    const from = memberName(members, handoff.fromBotId) ?? "bot";
    const to = memberName(members, handoff.toBotId) ?? "bot";
    return (
      <View style={{ paddingVertical: 4 }}>
        <Text style={{ color: "#85858A", fontSize: 13.5, textAlign: "center" }}>
          ↪ {to} ← {from}
          {handoff.text ? ` · ${handoff.text}` : ""}
        </Text>
      </View>
    );
  }
  const peerMessage = message.blocks.find(
    (
      block,
    ): block is Extract<MessageBlock, { kind: "bot_message_sent" | "bot_message_received" }> =>
      block.kind === "bot_message_sent" || block.kind === "bot_message_received",
  );
  if (peerMessage) {
    const sent = peerMessage.kind === "bot_message_sent";
    const peer = sent ? peerMessage.toBotName : peerMessage.fromBotName;
    // Peer traffic is the bots working, not this conversation, so it stays
    // collapsed to a line. Mobile has no peer-messages modal yet, so the line
    // opens in place rather than leaving the text unreachable here.
    return (
      <Pressable
        onPress={() => setPeerExpanded((expanded) => !expanded)}
        accessibilityRole="button"
        accessibilityLabel={
          sent
            ? peerExpanded
              ? `Hide message to ${peer}`
              : `Show message to ${peer}`
            : peerExpanded
              ? `Hide message from ${peer}`
              : `Show message from ${peer}`
        }
        style={{ paddingVertical: 4 }}
      >
        <Text style={{ color: "#85858A", fontSize: 13.5, textAlign: "center" }}>
          ↔ {sent ? `Messaged ${peer}` : `Message from ${peer}`}
        </Text>
        {peerExpanded ? (
          <View
            style={{
              marginTop: 6,
              borderRadius: 14,
              borderWidth: 1,
              borderColor: "#26262A",
              backgroundColor: "#101012",
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <ChatMarkdown>{peerMessage.text}</ChatMarkdown>
          </View>
        ) : null}
      </Pressable>
    );
  }
  const special = message.blocks.find(
    (block) => block.kind === "subagent" || block.kind === "child_bot",
  );
  if (special?.kind === "subagent") {
    const running = special.status === "running";
    const failed = special.status === "failed";
    return (
      <View
        style={{
          width: "90%",
          borderRadius: 18,
          borderWidth: 1,
          borderColor: "#232326",
          backgroundColor: "#17171A",
          paddingHorizontal: 16,
          paddingVertical: 14,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ color: "#ECECEE", fontSize: 15, fontWeight: "600" }}>
            {special.name || "subagent"}
          </Text>
          <Text
            style={{ color: failed ? "#E65707" : running ? "#F5A03C" : "#4ECB71", fontSize: 13 }}
          >
            {running ? "subagent" : special.status}
          </Text>
        </View>
        {special.task ? (
          <Text style={{ color: "#85858A", marginTop: 8, fontSize: 13.5 }}>{special.task}</Text>
        ) : null}
        {special.result || special.progress ? (
          <View style={{ marginTop: 8 }}>
            <ChatMarkdown streaming={running}>
              {special.result || special.progress || ""}
            </ChatMarkdown>
          </View>
        ) : null}
      </View>
    );
  }
  if (special?.kind === "child_bot") {
    const removed = special.status === "deleted" || special.status === "archived";
    return (
      <Pressable
        disabled={removed}
        onPress={() => onOpenBot(special.botId ?? "", special.name ?? "Bot")}
        style={{
          width: "90%",
          borderRadius: 18,
          borderWidth: 1,
          borderColor: "#232326",
          backgroundColor: "#17171A",
          paddingHorizontal: 16,
          paddingVertical: 14,
          opacity: removed ? 0.6 : 1,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
          <Text style={{ color: "#ECECEE", fontSize: 15, fontWeight: "600" }}>
            {special.name || "Bot"}
          </Text>
          <Text style={{ color: removed ? "#E65707" : "#4ECB71", fontSize: 13 }}>
            {special.status === "archived"
              ? "archived"
              : special.status === "deleted"
                ? "deleted"
                : "bot"}
          </Text>
        </View>
        <Text style={{ color: "#A8A8AD", marginTop: 8, fontSize: 14.5, lineHeight: 21 }}>
          {removed
            ? special.status === "archived"
              ? "Archived. Chat, memory, and files kept."
              : "Removed with chat, computer, and memory."
            : special.title || "Opened its thread."}
        </Text>
      </Pressable>
    );
  }
  if (appConnectBlocks.length > 0 && appConnectBlocks.length === message.blocks.length) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
        ))}
      </View>
    );
  }
  const askBlock = message.blocks.find(isApprovalAskBlock);
  if (askBlock?.kind === "ask" && askBlock.actions?.length) {
    return (
      <View style={{ gap: 8, width: "100%" }}>
        <View
          style={{
            width: "90%",
            borderRadius: 18,
            borderWidth: 1,
            borderColor: "#232326",
            backgroundColor: "#17171A",
            paddingHorizontal: 16,
            paddingVertical: 14,
          }}
        >
          {askBlock.text ? (
            <Text style={{ color: "#ECECEE", fontSize: 15.5, lineHeight: 23 }}>
              {askBlock.text}
            </Text>
          ) : null}
          {askBlock.detail ? (
            <Text
              style={{
                color: "#85858A",
                marginTop: 8,
                fontSize: 12.5,
                fontFamily: "Menlo",
                lineHeight: 20,
              }}
            >
              {askBlock.detail}
            </Text>
          ) : null}
          {askBlock.status === "answered" ? (
            <Text style={{ color: "#4ECB71", marginTop: 12, fontSize: 13.5, fontWeight: "600" }}>
              {formatApprovalAnswer(askBlock.answer)}
            </Text>
          ) : canAnswer ? (
            <AskActions actions={askBlock.actions} onAnswer={answer} />
          ) : (
            <Text style={{ color: "#85858A", marginTop: 12, fontSize: 13.5 }}>
              No longer active
            </Text>
          )}
        </View>
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
        ))}
      </View>
    );
  }
  const attachments = message.blocks.filter(
    (block) => block.kind === "image" || block.kind === "file",
  );
  const caption = message.blocks
    .flatMap((block) => (block.kind === "text" && block.text ? [block.text] : []))
    .join("\n");
  if (attachments.length > 0) {
    const speaker = message.role === "bot" ? memberName(members, message.botId) : undefined;
    return (
      <View
        style={{
          maxWidth: "100%",
          borderRadius: 20,
          borderWidth: 1,
          borderColor: "#26262A",
          backgroundColor: message.role === "user" ? "#F1F1EF" : "#1A1A1D",
          paddingHorizontal: 14,
          paddingVertical: 12,
          gap: 8,
        }}
      >
        {speaker ? (
          <Text style={{ color: "#85858A", fontSize: 12.5, fontWeight: "600" }}>{speaker}</Text>
        ) : null}
        {replyPreview ? (
          <Text style={{ color: "#85858A", fontSize: 12.5 }} numberOfLines={2}>
            {previewMessageText(replyPreview)}
          </Text>
        ) : null}
        {caption ? (
          <Text style={{ color: message.role === "user" ? "#1A1A1A" : "#DFDFE2", fontSize: 15 }}>
            {caption}
          </Text>
        ) : null}
        {attachments.map((attachment, index) =>
          attachment.kind === "image" ? (
            <Pressable
              key={`${attachment.artifactId ?? attachment.name ?? "image"}-${index}`}
              onPress={() =>
                attachment.artifactId
                  ? void openMobileArtifact(
                      artifactTarget,
                      attachment.artifactId,
                      attachment.name ?? "Image",
                      attachment.mimeType ?? "image/png",
                    ).catch((err) =>
                      Alert.alert(
                        "Could not open image",
                        err instanceof Error ? err.message : "Try again.",
                      ),
                    )
                  : undefined
              }
            >
              <Text
                style={{ color: message.role === "user" ? "#1A1A1A" : "#DFDFE2", fontSize: 15 }}
              >
                🖼 {attachment.name ?? "Image"}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              key={`${attachment.artifactId ?? attachment.name ?? "file"}-${index}`}
              onPress={() =>
                attachment.artifactId
                  ? attachment.mimeType === "text/markdown"
                    ? onPreviewMarkdown({
                        artifactId: attachment.artifactId,
                        name: attachment.name ?? "Markdown file",
                        mimeType: attachment.mimeType,
                      })
                    : void openMobileArtifact(
                        artifactTarget,
                        attachment.artifactId,
                        attachment.name ?? "File",
                        attachment.mimeType ?? "text/plain",
                      ).catch((err) =>
                        Alert.alert(
                          "Could not open file",
                          err instanceof Error ? err.message : "Try again.",
                        ),
                      )
                  : undefined
              }
            >
              <Text
                style={{ color: message.role === "user" ? "#1A1A1A" : "#DFDFE2", fontSize: 15 }}
              >
                📎 {attachment.name ?? "File"}
              </Text>
              {attachment.size ? (
                <Text style={{ color: "#85858A", marginTop: 4, fontSize: 13 }}>
                  {attachment.mimeType ?? "file"} · {attachment.size} bytes
                </Text>
              ) : null}
            </Pressable>
          ),
        )}
        {appConnectBlocks.map((block, index) => (
          <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
        ))}
      </View>
    );
  }
  const speaker = message.role === "bot" ? memberName(members, message.botId) : undefined;
  return (
    <View style={{ gap: 8, width: "100%" }}>
      <View
        style={{
          flexShrink: 1,
          minWidth: 0,
          maxWidth: "100%",
          backgroundColor: message.role === "user" ? "#F1F1EF" : "#1A1A1D",
          padding: 12,
          borderRadius: 20,
        }}
      >
        {speaker ? (
          <Text style={{ color: "#85858A", fontSize: 12.5, fontWeight: "600", marginBottom: 4 }}>
            {speaker}
          </Text>
        ) : null}
        {replyPreview ? (
          <Text style={{ color: "#85858A", fontSize: 12.5, marginBottom: 6 }} numberOfLines={2}>
            {previewMessageText(replyPreview)}
          </Text>
        ) : null}
        {message.role === "user" ? (
          <Text style={{ color: "#1A1A1A", fontSize: 15.5, lineHeight: 23 }}>
            {blockText(message)}
          </Text>
        ) : (
          <>
            <ChatMarkdown streaming={message.id.startsWith("progress:")}>
              {blockText(message)}
            </ChatMarkdown>
            {onSpeak ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Speak message"
                onPress={onSpeak}
                hitSlop={8}
                style={{ marginTop: 8 }}
              >
                <Text style={{ color: "#85858A", fontSize: 13 }}>Speak</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </View>
      {appConnectBlocks.map((block, index) => (
        <AppConnectCard key={`${block.provider}-${index}`} botId={cardBotId} block={block} />
      ))}
    </View>
  );
});

function AskBlock({
  ask,
  canAnswer,
  onAnswer,
}: {
  ask: Extract<MobileMessage["blocks"][number], { kind: "ask" }>;
  canAnswer: boolean;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const answered = ask.status === "answered";
  const secretInput = isSecretAskBlock(ask);

  async function submit() {
    if (submitting) return;
    if (secretInput ? answer.length === 0 : !answer.trim()) return;
    const submitValue = secretInput ? answer : answer.trim();
    setSubmitting(true);
    setError(null);
    try {
      await onAnswer(submitValue);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not send answer");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View
      style={{
        width: "90%",
        borderRadius: 18,
        borderWidth: 1,
        borderColor: "#2D2D31",
        backgroundColor: "#17171A",
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
      }}
    >
      <Text style={{ color: "#ECECEE", fontSize: 15.5, fontWeight: "600" }}>{ask.text}</Text>
      {ask.detail ? <Text style={{ color: "#85858A", fontSize: 13.5 }}>{ask.detail}</Text> : null}
      {answered ? (
        <Text style={{ color: "#4ECB71", fontSize: 14 }}>
          {secretInput ? "Submitted" : `Answered: ${ask.answer ?? "Done"}`}
        </Text>
      ) : canAnswer ? (
        <>
          <TextInput
            accessibilityLabel={secretInput ? "Code" : "Answer"}
            value={answer}
            onChangeText={setAnswer}
            placeholder={secretInput ? "Code" : "Type your answer"}
            placeholderTextColor="#6C6C70"
            secureTextEntry={secretInput}
            autoComplete="off"
            onSubmitEditing={() => void submit()}
            style={{
              minHeight: 42,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: "#35353A",
              color: "#ECECEE",
              paddingHorizontal: 12,
              paddingVertical: 9,
            }}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send answer"
            disabled={(secretInput ? answer.length === 0 : !answer.trim()) || submitting}
            onPress={() => void submit()}
            style={{
              alignSelf: "flex-end",
              borderRadius: 999,
              backgroundColor: "#ECECEE",
              opacity: (secretInput ? answer.length === 0 : !answer.trim()) || submitting ? 0.5 : 1,
              paddingHorizontal: 16,
              paddingVertical: 9,
            }}
          >
            <Text style={{ color: "#17171A", fontWeight: "600" }}>
              {submitting ? "Sending…" : "Send answer"}
            </Text>
          </Pressable>
        </>
      ) : (
        <Text style={{ color: "#85858A", fontSize: 13.5 }}>Waiting for this bot’s response.</Text>
      )}
      {error ? <Text style={{ color: "#E65707", fontSize: 13 }}>{error}</Text> : null}
    </View>
  );
}
