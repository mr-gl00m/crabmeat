/**
 * Renders the chat message history. Uses Ink's <Static> for committed
 * messages so they hit scrollback once and are never re-rendered —
 * essential for keeping per-tick redraws cheap during shimmer
 * animation. The currently-streaming assistant message renders
 * *outside* Static (in the App's dynamic region) so its content can
 * update on every chat.token event.
 *
 * Each message role gets its own row component:
 *   - user: framed with horizontal rules above and below
 *   - assistant: butter-yellow content, optional [done] tail
 *   - tool: dim status indicator
 *   - system: level-colored info/warn/error/success
 *   - outbound: message_send mirror with delivery badge
 */

import { Box, Text, Static } from "ink";
import type { ChatMessage } from "./reducer.js";

const RULE = "─".repeat(60);

export function ChatHistory({ messages }: { messages: ChatMessage[] }) {
  return (
    <Static items={messages}>
      {(msg) => <MessageRow key={msg.id} message={msg} />}
    </Static>
  );
}

export function MessageRow({ message }: { message: ChatMessage }) {
  switch (message.role) {
    case "user":
      return <UserMessage content={message.content} queued={message.queued} />;
    case "assistant":
      return (
        <AssistantMessage
          content={message.content}
          tokens={message.tokens}
          durationMs={message.durationMs}
          streaming={message.streaming}
        />
      );
    case "tool":
      return <ToolMessage toolName={message.toolName} status={message.status} />;
    case "system":
      return <SystemMessage content={message.content} level={message.level} />;
    case "outbound":
      return <OutboundMessage data={message.data} />;
    default:
      return null;
  }
}

function UserMessage({ content, queued }: { content: string; queued?: boolean }) {
  return (
    <Box flexDirection="column">
      <Text dimColor>{RULE}</Text>
      <Box paddingX={2}>
        <Text bold color="cyan">
          {queued ? "▸" : "❯"}
        </Text>
        <Text> {content}</Text>
      </Box>
      <Text dimColor>{RULE}</Text>
    </Box>
  );
}

export function AssistantMessage({
  content,
  tokens,
  durationMs,
  streaming,
}: {
  content: string;
  tokens: number;
  durationMs?: number;
  streaming: boolean;
}) {
  // Trailing summary mirrors the readline client's "[done] N tok · X.Xs"
  // line. Renders only after streaming completes so the live message
  // (rendered separately in App) doesn't show a fake "done" mid-stream.
  const showSummary = !streaming && durationMs !== undefined;
  const elapsedStr =
    durationMs !== undefined && durationMs >= 1000
      ? `${(durationMs / 1000).toFixed(1)}s`
      : `${durationMs ?? 0}ms`;
  return (
    <Box flexDirection="column" paddingX={2}>
      <Text color="yellow">{content}</Text>
      {showSummary ? (
        <Text dimColor>{`[done] ${tokens} tok · ${elapsedStr}`}</Text>
      ) : null}
    </Box>
  );
}

function ToolMessage({
  toolName,
  status,
}: {
  toolName: string;
  status: string;
}) {
  // Match the readline client's gray-tool-row look.
  let glyph: string;
  if (status === "running") glyph = "[>]";
  else if (status === "success") glyph = "[+]";
  else glyph = "[x]";
  const tail = status === "running" ? "running..." : status === "success" ? "done" : status;
  return (
    <Box paddingX={2}>
      <Text color="gray">{`${glyph} ${toolName} ${tail}`}</Text>
    </Box>
  );
}

function SystemMessage({
  content,
  level,
}: {
  content: string;
  level: "info" | "warn" | "error" | "success";
}) {
  const color =
    level === "error"
      ? "red"
      : level === "warn"
        ? "yellow"
        : level === "success"
          ? "green"
          : undefined;
  return (
    <Box paddingX={2}>
      <Text dimColor={level === "info"} color={color}>
        {content}
      </Text>
    </Box>
  );
}

function OutboundMessage({
  data,
}: {
  data: {
    channel: string;
    content: string;
    delivered: boolean;
    error?: string;
    killUrl?: string;
  };
}) {
  // Match the readline client's renderOutboundMirror: green [sent] /
  // red [failed] badge, dim → connector channel, dim preview lines,
  // optional kill URL.
  const preview =
    data.content.length > 200
      ? `${data.content.slice(0, 200)}…`
      : data.content;
  const previewLines = preview.split("\n");
  return (
    <Box flexDirection="column" paddingX={2}>
      <Box>
        <Text color={data.delivered ? "green" : "red"}>
          {data.delivered ? "[sent]" : "[failed]"}
        </Text>
        <Text dimColor>{" → "}</Text>
        <Text color="cyan">{data.channel}</Text>
      </Box>
      {previewLines.map((line, i) => (
        <Text key={i} dimColor>{`    ${line}`}</Text>
      ))}
      {!data.delivered && data.error ? (
        <Text color="red">{`error: ${data.error}`}</Text>
      ) : null}
      {data.killUrl ? (
        <Box>
          <Text dimColor>stop: </Text>
          <Text color="cyan">{data.killUrl}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
