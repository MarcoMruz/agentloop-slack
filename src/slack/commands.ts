import type { App } from "@slack/bolt";
import type { AgentLoopClient } from "../agentloop/client.js";
import type { SessionMap } from "./session-map.js";
import { isAllowed } from "../security/allowlist.js";
import { checkRateLimit } from "../security/rate-limiter.js";
import { buildSessionList } from "./blocks.js";
import { getWeather } from "../integrations/weather.js";
import { getCalendarEvents } from "../integrations/calendar.js";

export function registerCommands(
  app: App,
  agentloop: AgentLoopClient,
  _sessionMap: SessionMap,
) {
  // /weather — direct API call (no agent, fast)
  app.command("/weather", async ({ command, ack, respond }) => {
    await ack();
    if (!isAllowed(command.user_id)) {
      await respond("Unauthorized");
      return;
    }

    const city = command.text.trim() || "Presov";
    try {
      await respond({ response_type: "ephemeral", text: await getWeather(city) });
    } catch (err) {
      await respond(`Error: ${(err as Error).message}`);
    }
  });

  // /calendar — direct API call
  app.command("/calendar", async ({ command, ack, respond }) => {
    await ack();
    if (!isAllowed(command.user_id)) {
      await respond("Unauthorized");
      return;
    }

    try {
      await respond({
        response_type: "ephemeral",
        text: await getCalendarEvents(command.text || "today"),
      });
    } catch (err) {
      await respond(`Error: ${(err as Error).message}`);
    }
  });

  // /task — relay to AgentLoop
  app.command("/task", async ({ command, ack, respond }) => {
    await ack();
    if (!isAllowed(command.user_id)) {
      await respond("Unauthorized");
      return;
    }
    if (!command.text.trim()) {
      await respond("Usage: `/task [in ~/path] description`");
      return;
    }
    if (!checkRateLimit(command.user_id)) {
      await respond("Rate limit exceeded. Please wait a moment.");
      return;
    }

    const { workDir, cleanedText } = parseWorkDir(command.text);
    await respond(`Starting task: _${cleanedText}_`);

    try {
      await agentloop.startTask(command.user_id, cleanedText, workDir, "slack");
    } catch (err) {
      await respond(`Error: ${(err as Error).message}`);
    }
  });

  // /sessions — list active sessions
  app.command("/sessions", async ({ command, ack, respond }) => {
    await ack();
    if (!isAllowed(command.user_id)) {
      await respond("Unauthorized");
      return;
    }

    try {
      const sessions = await agentloop.listSessions(command.user_id);
      if (!sessions || sessions.length === 0) {
        await respond("No active sessions.");
        return;
      }
      const blocks = buildSessionList(sessions);
      await respond({ response_type: "ephemeral", text: "Sessions", blocks });
    } catch (err) {
      await respond(`Error: ${(err as Error).message}`);
    }
  });

  // /feedback — submit explicit feedback to trigger MemEvolve
  app.command("/feedback", async ({ command, ack, respond }) => {
    await ack();
    if (!isAllowed(command.user_id)) {
      await respond("Unauthorized");
      return;
    }

    const text = command.text.trim();
    if (!text) {
      await respond("Usage: `/feedback <what went wrong or what you expected>`");
      return;
    }

    try {
      await agentloop.submitFeedback({
        userId: command.user_id,
        text,
      });
      await respond(
        "✅ Feedback received — the agent will analyze it and may update its behavior. " +
        "You'll get a report here when evolution completes.",
      );
    } catch (err) {
      await respond(`Error submitting feedback: ${(err as Error).message}`);
    }
  });

  // /abort [sessionId] — abort a running session
  app.command("/abort", async ({ command, ack, respond }) => {
    await ack();
    if (!isAllowed(command.user_id)) {
      await respond("Unauthorized");
      return;
    }

    const sessionId = command.text.trim();

    // Direct abort by ID
    if (sessionId) {
      try {
        await agentloop.abortTask(sessionId);
        await respond(`Session \`${sessionId}\` aborted.`);
      } catch (err) {
        await respond(`Error: ${(err as Error).message}`);
      }
      return;
    }

    try {
      const sessions = await agentloop.listSessions(command.user_id, "running");
      if (!sessions || sessions.length === 0) {
        await respond("No active session to abort.");
        return;
      }
      if (sessions.length === 1) {
        await agentloop.abortTask(sessions[0].id);
        await respond("Session aborted.");
        return;
      }
      // Multiple sessions — let user pick
      const blocks = buildSessionList(sessions);
      await respond({
        response_type: "ephemeral",
        text: "Multiple sessions running. Choose one to abort:",
        blocks,
      });
    } catch (err) {
      await respond(`Error: ${(err as Error).message}`);
    }
  });
}

function parseWorkDir(text: string): { workDir?: string; cleanedText: string } {
  const match = text.match(/^in\s+(~\/[^\s]+)\s+/i);
  if (!match) return { cleanedText: text };
  return {
    workDir: match[1],
    cleanedText: text.slice(match[0].length).trim(),
  };
}
