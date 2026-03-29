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
import { buildHITLAutoApproved, buildHITLPrompt, buildTaskResult } from "./blocks.js";
import { isAllowed } from "../security/allowlist.js";
import { checkRateLimit } from "../security/rate-limiter.js";
import { logger } from "../utils/logger.js";

const TEXT_FLUSH_INTERVAL_MS = 1_000;
const MAX_SLACK_TEXT = 3500;

/**
 * Event handlers are PURE RELAYS:
 * 1. Receive Slack message
 * 2. Validate user allowlist + rate limit
 * 3. Forward to AgentLoop via socket
 * 4. Stream events back to Slack
 *
 * NO memory, NO context, NO session logic.
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
      cleanedText,
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
 * Wire up AgentLoop event listeners for a session and stream results to Slack.
 * Returns a cleanup function that removes all listeners.
 */
function setupSessionListeners(
  agentloop: AgentLoopClient,
  client: WebClient,
  sessionMap: SessionMap,
  sessionId: string,
  channelId: string,
  threadTs: string,
  taskDescription: string,
) {
  const textChunks: string[] = [];
  let streamMessageTs: string | undefined;
  let flushTimer: NodeJS.Timeout | null = null;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (flushTimer) clearTimeout(flushTimer);
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

  // Flush accumulated text to Slack (create or update message)
  const flushText = async () => {
    if (textChunks.length === 0) return;
    const text = textChunks.join("");
    const truncated =
      text.length > MAX_SLACK_TEXT
        ? text.slice(0, MAX_SLACK_TEXT - 20) + "\n...[streaming]"
        : text;

    try {
      if (!streamMessageTs) {
        const msg = await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: truncated,
        });
        streamMessageTs = msg.ts;
        // Store it in session map for reference
        if (info) info.messageTs = streamMessageTs;
      } else {
        await client.chat.update({
          channel: channelId,
          ts: streamMessageTs,
          text: truncated,
        });
      }
    } catch (err) {
      logger.warn("Failed to update stream message", {
        error: (err as Error).message,
      });
    }
  };

  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushText();
    }, TEXT_FLUSH_INTERVAL_MS);
  };

  // --- Event listeners (filter by sessionId) ---

  const onText = (p: TextEventParams) => {
    if (p.sessionId !== sessionId) return;
    textChunks.push(p.content);
    scheduleFlush();
  };

  const onToolUse = async (p: ToolUseEventParams) => {
    if (p.sessionId !== sessionId) return;
    await client.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Using tool: \`${p.toolName}\``,
      })
      .catch(() => {});
  };

  const onHITL = async (p: HITLRequestEventParams) => {
    if (p.sessionId !== sessionId) return;
    await client.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `🔒 Security Approval Required - ${p.rule || p.toolName || 'Permission needed'}`,
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

    // Flush any remaining text
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const fullOutput = textChunks.join("");

    // Upload full output as file if too long
    if (fullOutput.length > MAX_SLACK_TEXT) {
      await client.files
        .uploadV2({
          channel_id: channelId,
          thread_ts: threadTs,
          content: fullOutput,
          filename: `${sessionId}.md`,
          title: `Output: ${taskDescription.slice(0, 50)}`,
        })
        .catch(() => {});
    }

    // Post or update final result
    const displayOutput = fullOutput || p.output || "(no output)";
    const truncated =
      displayOutput.length > MAX_SLACK_TEXT
        ? displayOutput.slice(0, MAX_SLACK_TEXT - 20) + "\n...[truncated]"
        : displayOutput;

    try {
      if (streamMessageTs) {
        await client.chat.update({
          channel: channelId,
          ts: streamMessageTs,
          text: truncated,
          blocks: buildTaskResult(truncated, true, p.stats),
        });
      } else {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: truncated,
          blocks: buildTaskResult(truncated, true, p.stats),
        });
      }
    } catch (err) {
      logger.warn("Failed to post task result", {
        error: (err as Error).message,
      });
    }

    // Update reactions
    await client.reactions
      .remove({ channel: channelId, timestamp: threadTs, name: "eyes" })
      .catch(() => {});
    await client.reactions
      .add({ channel: channelId, timestamp: threadTs, name: "white_check_mark" })
      .catch(() => {});

    cleanup();
    sessionMap.remove(sessionId);
  };

  const onError = async (p: ErrorEventParams) => {
    if (p.sessionId !== sessionId) return;

    await client.chat
      .postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Error: ${p.message}`,
      })
      .catch(() => {});

    await client.reactions
      .remove({ channel: channelId, timestamp: threadTs, name: "eyes" })
      .catch(() => {});
    await client.reactions
      .add({ channel: channelId, timestamp: threadTs, name: "x" })
      .catch(() => {});

    cleanup();
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
