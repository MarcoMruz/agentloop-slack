import { Assistant } from "@slack/bolt";
import type { App, SayFn } from "@slack/bolt";
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
 * Registers the Slack Assistant handler.
 *
 * The assistant is a thin relay:
 * - threadStarted: set initial title/prompts
 * - threadContextChanged: no-op (context is managed by AgentLoop)
 * - userMessage: start or steer an AgentLoop task, stream events back
 *
 * Uses say() and setStatus() from Bolt's AssistantUtilityArgs instead of
 * direct WebClient calls for assistant thread messages.
 */
export function registerAssistant(
  app: App,
  agentloop: AgentLoopClient,
  sessionMap: SessionMap,
) {
  const assistant = new Assistant({
    threadStarted: async ({ setTitle, setSuggestedPrompts, setStatus }) => {
      await setTitle("AgentLoop").catch(() => {});
      await setSuggestedPrompts({
        prompts: [
          {
            title: "Start a task",
            message: "in ~/development/<project> do something useful",
          },
          {
            title: "List active sessions",
            message: "What sessions are currently running?",
          },
        ],
      }).catch(() => {});
      await setStatus("").catch(() => {});
    },

    threadContextChanged: async () => {
      // Context changes are managed entirely by AgentLoop server.
      // No action needed in the bridge.
    },

    userMessage: async ({ message, event, say, setStatus, setTitle, client }) => {
      // Resolve user from message or event
      const userId =
        ("user" in message && typeof message.user === "string" && message.user) ||
        ("user" in event && typeof event.user === "string" && event.user) ||
        undefined;

      if (!userId) return;
      if (!isAllowed(userId)) {
        await say("You are not authorized to use this assistant.").catch(() => {});
        return;
      }
      if (!checkRateLimit(userId)) {
        await say("Rate limit exceeded. Please wait a moment.").catch(() => {});
        return;
      }

      const text = ("text" in message && typeof message.text === "string" ? message.text : "") || "";
      if (!text.trim()) return;

      // Resolve channelId and threadTs from the message
      const channelId =
        ("channel" in message && typeof message.channel === "string" ? message.channel : "") ||
        ("channel_id" in event && typeof (event as Record<string, unknown>).channel_id === "string"
          ? String((event as Record<string, unknown>).channel_id)
          : "");
      const threadTs =
        ("thread_ts" in message && typeof message.thread_ts === "string" ? message.thread_ts : "") ||
        ("ts" in message && typeof message.ts === "string" ? message.ts : "");

      if (!channelId || !threadTs) {
        logger.warn("assistant.userMessage: missing channelId or threadTs", { userId });
        return;
      }

      // If there's an existing session for this thread → steer it
      const existingSessionId = sessionMap.getByThread(channelId, threadTs);
      if (existingSessionId) {
        await setStatus("is thinking...").catch(() => {});
        try {
          await agentloop.steerTask(existingSessionId, text);
        } catch (err) {
          await say(`Failed to steer task: ${(err as Error).message}`).catch(() => {});
          await setStatus("").catch(() => {});
        }
        return;
      }

      // New task: set title from first message
      const titleText = text.slice(0, 80).trim();
      await setTitle(titleText || "New task").catch(() => {});
      await setStatus("is thinking...").catch(() => {});

      const { workDir, cleanedText } = parseWorkDir(text);

      try {
        const result = await agentloop.startTask(userId, cleanedText, workDir, "slack");
        const sessionId = result.sessionId;

        // Register session → thread mapping
        sessionMap.set(sessionId, { channelId, threadTs, userId });

        // Wire up streaming event listeners
        setupAssistantListeners(agentloop, sessionMap, sessionId, say, setStatus, client, channelId, threadTs);
      } catch (err) {
        const errMsg = (err as Error).message;
        logger.error("assistant: failed to start task", { error: errMsg });
        const isMaxSessions = errMsg.toLowerCase().includes("max sessions");
        await say(
          isMaxSessions
            ? `${errMsg}\nUse \`/sessions\` to see active sessions or \`/abort\` to end one.`
            : `Failed to start task: ${errMsg}`,
        ).catch(() => {});
        await setStatus("").catch(() => {});
      }
    },
  });

  app.assistant(assistant);
}

/**
 * Wire up AgentLoop event listeners for an assistant thread session.
 *
 * Text is streamed progressively: chunks are buffered and flushed every
 * TEXT_FLUSH_INTERVAL_MS. The first flush uses say() to post a new message
 * (which attaches assistant thread metadata); subsequent flushes call
 * client.chat.update on that message's ts. On event.done the message is
 * updated with the final authoritative output.
 */
function setupAssistantListeners(
  agentloop: AgentLoopClient,
  sessionMap: SessionMap,
  sessionId: string,
  say: SayFn,
  setStatus: (status: string) => Promise<unknown>,
  client: WebClient,
  channelId: string,
  threadTs: string,
) {
  let cleaned = false;
  let textBuffer = "";
  let streamTs: string | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flushText = async () => {
    flushTimer = undefined;
    if (!textBuffer) return;
    const text = textBuffer;
    if (!streamTs) {
      // First flush: use say() to get assistant thread metadata attached.
      const result = await say(text).catch(() => undefined) as { ts?: string } | undefined;
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

  // Accumulate text chunks and schedule a Slack update.
  const onText = (p: TextEventParams) => {
    if (p.sessionId !== sessionId) return;
    textBuffer += p.content;
    scheduleFlush();
  };

  // Tool use: update status with current tool name
  const onToolUse = (p: ToolUseEventParams) => {
    if (p.sessionId !== sessionId) return;
    void setStatus(`is using ${p.toolName}...`).catch(() => {});
  };

  const onHITL = async (p: HITLRequestEventParams) => {
    if (p.sessionId !== sessionId) return;
    await say({
      text: `🔒 Security Approval Required - ${p.rule || p.toolName || "Permission needed"}`,
      blocks: buildHITLPrompt(p),
    }).catch(() => {});
  };

  const onHITLAutoApproved = async (p: HITLAutoApprovedEventParams) => {
    if (p.sessionId !== sessionId) return;
    await say({
      text: `✅ Auto-approved: \`${p.toolName}\``,
      blocks: buildHITLAutoApproved(p),
    }).catch(() => {});
  };

  const onDone = async (p: DoneEventParams) => {
    if (p.sessionId !== sessionId) return;

    cleanup();
    await setStatus("").catch(() => {});

    // Use server's authoritative output; fall back to accumulated buffer.
    const finalText = (p.output && p.output.trim()) ? p.output : textBuffer;

    if (finalText.trim()) {
      if (streamTs) {
        await client.chat
          .update({ channel: channelId, ts: streamTs, text: finalText })
          .catch(() => {});
      } else {
        await say(finalText).catch(() => {});
      }
    } else {
      if (!streamTs) await say("Task completed.").catch(() => {});
    }

    sessionMap.remove(sessionId);
  };

  const onError = async (p: ErrorEventParams) => {
    if (p.sessionId !== sessionId) return;

    cleanup();
    await setStatus("").catch(() => {});

    const errorText = `Error: ${p.message}`;
    if (streamTs) {
      await client.chat
        .update({ channel: channelId, ts: streamTs, text: errorText })
        .catch(() => {});
    } else {
      await say(errorText).catch(() => {});
    }

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
