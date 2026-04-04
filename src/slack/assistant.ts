import { Assistant } from "@slack/bolt";
import type { App, SayFn } from "@slack/bolt";
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
        setupAssistantListeners(agentloop, sessionMap, sessionId, say, setStatus);
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
 * Uses say() from AssistantUtilityArgs for thread messages and setStatus()
 * for progress indicators. HITL messages are posted via say() with Block Kit.
 */
function setupAssistantListeners(
  agentloop: AgentLoopClient,
  sessionMap: SessionMap,
  sessionId: string,
  say: SayFn,
  setStatus: (status: string) => Promise<unknown>,
) {
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
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

  // Text chunks: no-op — final output posted by onDone
  const onText = (_p: TextEventParams) => {};

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

    if (p.output && p.output.trim()) {
      await say(p.output).catch(() => {});
    } else {
      await say("Task completed.").catch(() => {});
    }

    sessionMap.remove(sessionId);
  };

  const onError = async (p: ErrorEventParams) => {
    if (p.sessionId !== sessionId) return;

    cleanup();
    await setStatus("").catch(() => {});
    await say(`Error: ${p.message}`).catch(() => {});
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
