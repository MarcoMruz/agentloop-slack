import type { KnownBlock } from "@slack/types";
import type { DoneEventParams, HITLRequestEventParams, SessionInfo } from "../agentloop/types.js";

const MAX_TEXT_LENGTH = 3000;

function truncate(text: string, maxLen = MAX_TEXT_LENGTH): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 20) + "\n...[truncated]";
}

/**
 * Build Block Kit HITL approval prompt with Approve / Deny / Abort buttons.
 */
export function buildHITLPrompt(
  sessionId: string,
  requestId: string,
  toolName: string,
  details: string,
  command?: string,
  workDir?: string,
  rule?: string,
): KnownBlock[] {
  // Build enhanced display with command and rule
  let displayText = `*Security Approval Required*`;
  
  if (rule) {
    displayText += `\n🛡️ *Rule:* ${rule}`;
  }
  
  if (command) {
    displayText += `\n⚡ *Command:* \`\`\`${truncate(command, 500)}\`\`\``;
  }
  
  if (workDir) {
    displayText += `\n📁 *Project:* ${workDir}`;
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(displayText, 2000),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: "hitl_approve",
          value: `${sessionId}:${requestId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          action_id: "hitl_deny",
          value: `${sessionId}:${requestId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Abort Task" },
          action_id: "hitl_abort",
          value: `${sessionId}:${requestId}`,
        },
      ],
    },
  ];
}

/**
 * Build task result blocks with output and stats.
 */
export function buildTaskResult(
  output: string,
  success: boolean,
  stats?: DoneEventParams["stats"],
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(output),
      },
    },
  ];

  const contextParts: string[] = [];
  if (success) contextParts.push("Status: complete");
  if (stats) {
    contextParts.push(`Tokens: ~${stats.tokens}`);
    contextParts.push(`Tools: ${stats.toolCalls}`);
    contextParts.push(stats.duration);
  }

  if (contextParts.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: contextParts.join(" | ") }],
    });
  }

  return blocks;
}

/**
 * Build session list display with per-session Abort buttons.
 */
export function buildSessionList(sessions: SessionInfo[]): KnownBlock[] {
  if (sessions.length === 0) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: "No active sessions." },
      },
    ];
  }

  return sessions.map((s): KnownBlock => ({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `\`${s.id}\` — ${s.task || "unnamed"} _(${s.state})_`,
    },
    accessory: {
      type: "button",
      text: { type: "plain_text", text: "Abort" },
      style: "danger",
      action_id: "session_abort",
      value: s.id,
    },
  }));
}
