import { App } from "@slack/bolt";
import { config } from "./config.js";
import { AgentLoopClient } from "./agentloop/client.js";
import { SessionMap } from "./slack/session-map.js";
import { registerEvents } from "./slack/events.js";
import { registerCommands } from "./slack/commands.js";
import { registerActions } from "./slack/actions.js";
import { registerAssistant } from "./slack/assistant.js";
import { logger, setLogLevel } from "./utils/logger.js";

async function main() {
  setLogLevel(config.LOG_LEVEL);

  // Connect to AgentLoop server
  const agentloop = new AgentLoopClient(config.AGENTLOOP_SOCKET);
  await agentloop.connect();

  // Verify server is running
  const health = await agentloop.healthCheck();
  logger.info("AgentLoop server healthy", health as unknown as Record<string, unknown>);

  // Start Slack app (Socket Mode)
  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    appToken: config.SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Session tracking
  const sessionMap = new SessionMap();

  // Register all Slack handlers
  registerEvents(app, agentloop, sessionMap);
  registerCommands(app, agentloop, sessionMap);
  registerActions(app, agentloop, sessionMap);
  registerAssistant(app, agentloop, sessionMap);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    await agentloop.disconnect();
    await app.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.start();
  logger.info("Slack Bridge running (thin transport layer)");
}

main().catch((err) => {
  logger.error("Fatal", { error: (err as Error).message });
  process.exit(1);
});
