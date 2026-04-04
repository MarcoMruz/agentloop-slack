import type { App } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { AgentLoopClient } from "../agentloop/client.js";
import type {
  TextEventParams,
  ToolUseEventParams,
  HITLRequestEventParams,
  HITLAutoApprovedEventParams,
  DoneEventParams,
  ErrorEventParams,
} from "../agentloop/types.js";
import type { SessionMap } from "./session-map.js";
import { buildHITLAutoApproved, buildHITLPrompt } from "./blocks.js";
import { isAllowed } from "../security/allowlist.js";
import { checkRateLimit } from "../security/rate-limiter.js";
import { logger } from "../utils/logger.js";

const TEXT_FLUSH_INTERVAL_MS = 1_000;

/**
 * Event handlers are PURE RELAYS:
 * 1. Receive Slack message
 * 2. Validate user allowlist + rate limit
 * 3. Forward to AgentLoop via socket
 * 4. Stream events back to Slack
 *
 * NO memory, NO context, NO session logic.
 *
 * Thread output policy:
 * - While running: streaming text updates + tool-use status
 * - Thread messages: HITL requests and auto-approved HITL only
 * - Completion: final text update + reaction (eyes → ✅ or ❌)
 */
export function registerEvents(
  app: App,
  agentloop: AgentLoopClient,
  sessionMap: SessionMap,
) {
  // Direct messages
  app.message(async ({ message, client }) => {
    if (message.subtype || !("text" in message) || !message.user) return;
    if (!isAllowed(message.user)) return;
    if (!checkRateLimit(message.user)) {
      await client.chat
        .postMessage({
          channel: message.channel,
          thread_ts: message.ts,
          text: "Rate limit exceeded. Please wait a moment.",
        })
        .catch(() => {});
      return;
    }

    const text = message.text || "";
    const channelId = message.channel;
    const threadTs = message.thread_ts || message.ts;

    // Thread reply to existing session → steer
    const existingSessionId = message.thread_ts
      ? sessionMap.getByThread(channelId, message.thread_ts)
      : undefined;

    if (existingSessionId) {
      try {
        await agentloop.steerTask(existingSessionId, text);
      } catch (err) {
        await client.chat
          .postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `Failed to steer task: ${(err as Error).message}`,
          })
          .catch(() => {});
      }
      return;
    }

    // New message → start task
    await startTaskFromMessage(
      agentloop,
      client,
      sessionMap,
      message.user,
      text,
      channelId,
      message.ts,
    );
  });

  // @mentions
  app.event("app_mention", async ({ event, client }) => {
    const user = event.user;
    if (!user) return;
    if (!isAllowed(user)) return;
    if (!checkRateLimit(user)) {
      await client.chat
        .postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: "Rate limit exceeded. Please wait a moment.",
        })
        .catch(() => {});
      return;
    }

    const text = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "Mention me with a task!",
      });
      return;
    }

    const channelId = event.channel;
    const threadTs = ("thread_ts" in event && event.thread_ts) ? event.thread_ts : event.ts;

    // Thread reply to existing session → steer
    const parentTs = "thread_ts" in event ? event.thread_ts : undefined;
    const existingSessionId = parentTs
      ? sessionMap.getByThread(channelId, parentTs)
      : undefined;

    if (existingSessionId) {
      try {
        await agentloop.steerTask(existingSessionId, text);
      } catch (err) {
        await client.chat
          .postMessage({
            channel: channelId,
            thread_ts: threadTs,
            text: `Failed to steer task: ${(err as Error).message}`,
          })
          .catch(() => {});
      }
      return;
    }

    await startTaskFromMessage(
      agentloop,
      client,
      sessionMap,
      user,
      text,
      channelId,
      event.ts,
    );
  });
}

/**
 * Start a new AgentLoop task and wire up event streaming back to Slack.
 */
async function startTaskFromMessage(
  agentloop: AgentLoopClient,
  client: WebClient,
  sessionMap: SessionMap,
  userId: string,
  rawText: string,
  channelId: string,
  messageTs: string,
) {
  // Add eyes reaction to indicate processing
  await client.reactions
    .add({ channel: channelId, timestamp: messageTs, name: "eyes" })
    .catch(() => {});

  const { workDir, cleanedText } = parseWorkDir(rawText);

  try {
    const result = await agentloop.startTask(userId, cleanedText, workDir, "slack");
    const sessionId = result.sessionId;

    // Register session → thread mapping
    sessionMap.set(sessionId, {
      channelId,
      threadTs: messageTs,
      userId,
    });

    // Set up streaming event listeners for this session
    setupSessionListeners(
      agentloop,
      client,
      sessionMap,
      sessionId,
      channelId,
      messageTs,
    );
  } catch (err) {
    const errMsg = (err as Error).message;
    logger.error("Failed to start task", { error: errMsg });
    const isMaxSessions = errMsg.toLowerCase().includes("max sessions");
    await client.chat
      .postMessage({
        channel: channelId,
        thread_ts: messageTs,
        text: isMaxSessions
          ? `${errMsg}\nUse \`/sessions\` to see active sessions or \`/abort\` to end one.`
          : `Failed to start task: ${errMsg}`,
      })
      .catch(() => {});
    await client.reactions
      .remove({ channel: channelId, timestamp: messageTs, name: "eyes" })
      .catch(() => {});
    await client.reactions
      .add({ channel: channelId, timestamp: messageTs, name: "x" })
      .catch(() => {});
  }
}

/**
 * Set or clear the assistant thread status indicator.
 * Requires assistant:write scope and "Agents and AI Apps" feature enabled.
 */
async function setThreadStatus(
  client: WebClient,
  channelId: string,
  threadTs: string,
  status: string,
): Promise<void> {
  await (client.assistant.threads as unknown as {
    setStatus: (args: { channel_id: string; thread_ts: string; status: string }) => Promise<void>;
  })
    .setStatus({ channel_id: channelId, thread_ts: threadTs, status })
    .catch(() => {});
}

/**
 * Wire up AgentLoop event listeners for a session.
 *
 * Text is streamed progressively: chunks are buffered and flushed to Slack
 * every TEXT_FLUSH_INTERVAL_MS. The first flush posts a new message; subsequent
 * flushes update it in place. On event.done the message is updated with the
 * final authoritative output.
 */
function setupSessionListeners(
  agentloop: AgentLoopClient,
  client: WebClient,
  sessionMap: SessionMap,
  sessionId: string,
  channelId: string,
  threadTs: string,
) {
  let cleaned = false;
  let textBuffer = "";
  let streamTs: string | undefined; // ts of the streaming message being updated
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flushText = async () => {
    flushTimer = undefined;
    if (!textBuffer) return;
    const text = textBuffer;
    if (!streamTs) {
      const result = await client.chat
        .postMessage({ channel: channelId, thread_ts: threadTs, text })
        .catch(() => undefined);
      streamTs = result?.ts;
    } else {
      await client.chat
        .update({ channel: channelId, ts: streamTs, text })
        .catch(() => {});
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { void flushText(); }, TEXT_FLUSH_INTERVAL_MS);
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    agentloop.off("event.text", onText);
    agentloop.off("event.tool_use", onToolUse);
    agentloop.off("event.hitl_request", onHITL);
    agentloop.off("event.hitl_auto_approved", onHITLAutoApproved);
    agentloop.off("event.done", onDone);
    agentloop.off("event.error", onError);
  };

  // Store cleanup in session map
  const info = sessionMap.getBySession(sessionId);
  if (info) info.cleanup = cleanup;

  // Set initial "thinking" status
  void setThreadStatus(client, channelId, threadTs, "is thinking...");

  // --- Event listeners (all filter by sessionId) ---

  // Accumulate text chunks and schedule a Slack update.
  const onText = (p: TextEventParams) => {
    if (p.sessionId !== sessionId) return;
    textBuffer += p.content;
    scheduleFlush();
  };

  // Tool use: update status to show which tool is running.
  const onToolUse = (p: ToolUseEventParams) => {
    if (p.sessionId !== sessionId) return;
    void setThreadStatus(client, channelId, threadTs, `is using ${p.toolName}...`);
  };

  const onHITL = async (p: HITLRequestEventParams) => {
    if (p.sessionId !== sessionId) return;
    await client.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `🔒 Security Approval Required - ${p.rule || p.toolName || "Permission needed"}`,
        blocks: buildHITLPrompt(p),
      })
      .catch(() => {});
  };

  const onHITLAutoApproved = async (p: HITLAutoApprovedEventParams) => {
    if (p.sessionId !== sessionId) return;
    await client.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `✅ Auto-approved: \`${p.toolName}\``,
        blocks: buildHITLAutoApproved(p),
      })
      .catch(() => {});
  };

  const onDone = async (p: DoneEventParams) => {
    if (p.sessionId !== sessionId) return;

    cleanup();
    await setThreadStatus(client, channelId, threadTs, "");

    // Use server's authoritative output; fall back to accumulated buffer.
    const finalText = (p.output && p.output.trim()) ? p.output : textBuffer;

    if (finalText.trim()) {
      if (streamTs) {
        // Update the in-progress streaming message with final content.
        await client.chat
          .update({ channel: channelId, ts: streamTs, text: finalText })
          .catch(() => {});
      } else {
        // No streaming happened yet — post directly.
        await client.chat
          .postMessage({ channel: channelId, thread_ts: threadTs, text: finalText })
          .catch(() => {});
      }
    }

    await client.reactions
      .remove({ channel: channelId, timestamp: threadTs, name: "eyes" })
      .catch(() => {});
    await client.reactions
      .add({ channel: channelId, timestamp: threadTs, name: "white_check_mark" })
      .catch(() => {});

    sessionMap.remove(sessionId);
  };

  const onError = async (p: ErrorEventParams) => {
    if (p.sessionId !== sessionId) return;

    cleanup();
    await setThreadStatus(client, channelId, threadTs, "");

    const errorText = `Error: ${p.message}`;
    if (streamTs) {
      await client.chat
        .update({ channel: channelId, ts: streamTs, text: errorText })
        .catch(() => {});
    } else {
      await client.chat
        .postMessage({ channel: channelId, thread_ts: threadTs, text: errorText })
        .catch(() => {});
    }

    await client.reactions
      .remove({ channel: channelId, timestamp: threadTs, name: "eyes" })
      .catch(() => {});
    await client.reactions
      .add({ channel: channelId, timestamp: threadTs, name: "x" })
      .catch(() => {});

    sessionMap.remove(sessionId);
  };

  // Register all listeners
  agentloop.on("event.text", onText);
  agentloop.on("event.tool_use", onToolUse);
  agentloop.on("event.hitl_request", onHITL);
  agentloop.on("event.hitl_auto_approved", onHITLAutoApproved);
  agentloop.on("event.done", onDone);
  agentloop.on("event.error", onError);
}

/**
 * Parse optional "in ~/path" prefix from message text.
 */
function parseWorkDir(text: string): { workDir?: string; cleanedText: string } {
  const match = text.match(/^in\s+(~\/[^\s]+)\s+/i);
  if (!match) return { cleanedText: text };
  return {
    workDir: match[1],
    cleanedText: text.slice(match[0].length).trim(),
  };
}
