import type { KnownBlock } from "@slack/types";
import type { DoneEventParams, HITLRequestEventParams, SessionInfo } from "../agentloop/types.js";

const MAX_TEXT_LENGTH = 3000;
const MAX_WHITELISTED_PATHS = 10;
const MAX_STRUCTURED_INPUT_KEYS = 8;

function truncate(text: string, maxLen = MAX_TEXT_LENGTH): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 20) + "\n...[truncated]";
}

const RISK_BADGES: Record<string, string> = {
  high: "🔴 HIGH",
  medium: "🟡 MEDIUM",
  low: "🟢 LOW",
};

const CATEGORY_ICONS: Record<string, string> = {
  file: "📂",
  bash: "💻",
  network: "🌐",
  process: "⚙️",
  other: "🔧",
};

function hasEnrichedFields(params: HITLRequestEventParams): boolean {
  return !!(
    params.filePath ||
    params.whitelistedPaths ||
    params.structuredInput ||
    params.riskLevel ||
    params.reason ||
    params.toolCategory
  );
}

function buildRiskHeader(params: HITLRequestEventParams): string {
  const badge = params.riskLevel ? RISK_BADGES[params.riskLevel] : undefined;
  const icon = params.toolCategory ? CATEGORY_ICONS[params.toolCategory] ?? "🔧" : undefined;
  const prefix = badge ? `${badge}  ` : "";
  const toolIcon = icon ? `${icon} ` : "";
  return `${prefix}🔒 *Security Approval Required*\n${toolIcon}${params.toolName}`;
}

function buildWhyBlocked(params: HITLRequestEventParams): string {
  if (params.reason) return `*Why blocked:* ${params.reason}`;
  if (params.rule) return `*Why blocked:* ${params.rule}`;
  return "";
}

function buildRequestedPath(params: HITLRequestEventParams): string {
  if (!params.filePath) return "";
  return `*Requested path:*\n\`${truncate(params.filePath, 200)}\``;
}

function buildWhitelistedPaths(params: HITLRequestEventParams): string {
  if (params.toolCategory !== "file") return "";
  const paths = params.whitelistedPaths;
  if (!paths || paths.length === 0) {
    return `*Whitelisted paths:* _(none configured — all paths require approval)_`;
  }
  const visible = paths.slice(0, MAX_WHITELISTED_PATHS);
  const lines = visible.map((p) => `• ${p}`);
  const remaining = paths.length - visible.length;
  if (remaining > 0) lines.push(`…(${remaining} more)`);
  return `*Whitelisted paths (allowed):*\n${lines.join("\n")}`;
}

function buildStructuredInput(params: HITLRequestEventParams): string {
  if (!params.structuredInput) return "";
  const entries = Object.entries(params.structuredInput);
  if (entries.length === 0) return "";
  const visible = entries.slice(0, MAX_STRUCTURED_INPUT_KEYS);
  const maxKeyLen = Math.max(...visible.map(([k]) => k.length));
  const lines = visible.map(([k, v]) => `${k.padEnd(maxKeyLen)}  ${String(v)}`);
  const remaining = entries.length - visible.length;
  if (remaining > 0) lines.push(`…(${remaining} more)`);
  return `*Tool input:*\n\`\`\`${lines.join("\n")}\`\`\``;
}

function buildEnrichedDisplay(params: HITLRequestEventParams): string {
  const sections = [
    buildRiskHeader(params),
    buildWhyBlocked(params),
    buildRequestedPath(params),
    buildWhitelistedPaths(params),
    buildStructuredInput(params),
  ];

  if (params.workDir) {
    sections.push(`*Working directory:* \`${params.workDir}\``);
  }

  return sections.filter((s) => s.length > 0).join("\n\n");
}

function buildLegacyDisplay(params: HITLRequestEventParams): string {
  let displayText = `🔒 *Security Approval Required*`;

  if (params.toolName) {
    displayText += `\n🔧 *Tool:* ${params.toolName}`;
  }
  if (params.rule) {
    displayText += `\n🛡️ *Security Rule:* ${params.rule}`;
  }
  if (params.method) {
    displayText += `\n📋 *Method:* ${params.method}`;
  }
  if (params.workDir) {
    displayText += `\n📁 *Working Directory:* \`${params.workDir}\``;
  }
  if (params.command && params.command.trim()) {
    displayText += `\n⚡ *Command Details:*\n\`\`\`${truncate(params.command, 800)}\`\`\``;
  }
  if (params.details && params.details !== params.toolName && params.details.trim()) {
    displayText += `\n📝 *Additional Info:*\n${truncate(params.details, 600)}`;
  }

  displayText += `\n\n*Please review the above information carefully before making a decision.*`;
  return displayText;
}

/**
 * Build Block Kit HITL approval prompt with Approve / Deny / Abort buttons.
 * Renders enriched view when new fields are present, legacy view otherwise.
 */
export function buildHITLPrompt(params: HITLRequestEventParams): KnownBlock[] {
  const displayText = hasEnrichedFields(params)
    ? buildEnrichedDisplay(params)
    : buildLegacyDisplay(params);

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: truncate(displayText, 2800),
      },
    },
    {
      type: "divider",
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Session:* \`${params.sessionId}\` • *Request:* \`${params.requestId}\``,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "✅ Approve" },
          style: "primary",
          action_id: "hitl_approve",
          value: `${params.sessionId}:${params.requestId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "❌ Deny" },
          style: "danger",
          action_id: "hitl_deny",
          value: `${params.sessionId}:${params.requestId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🛑 Abort Task" },
          action_id: "hitl_abort",
          value: `${params.sessionId}:${params.requestId}`,
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
