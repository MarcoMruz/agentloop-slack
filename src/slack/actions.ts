import type { App } from "@slack/bolt";
import type { AgentLoopClient } from "../agentloop/client.js";
import type { SessionMap } from "./session-map.js";
import { isAllowed } from "../security/allowlist.js";
import { logger } from "../utils/logger.js";

/**
 * HITL actions are PURE RELAYS.
 * User clicks button -> we relay decision to AgentLoop server.
 * We never make the decision.
 */
export function registerActions(
  app: App,
  agentloop: AgentLoopClient,
  _sessionMap: SessionMap,
) {
  app.action("hitl_approve", async ({ body, ack, client }) => {
    await ack();
    if (!isAllowed(body.user.id)) return;

    const value = (body as any).actions?.[0]?.value || "";
    const [sessionId, requestId] = value.split(":");

    try {
      await agentloop.respondHITL(sessionId, requestId, "approve");
      if ("message" in body && "channel" in body) {
        await client.chat.update({
          channel: (body as any).channel.id,
          ts: (body as any).message.ts,
          text: `Approved by <@${body.user.id}>`,
          blocks: [],
        });
      }
    } catch (err) {
      logger.error("Failed to approve HITL", { error: (err as Error).message });
    }
  });

  app.action("hitl_deny", async ({ body, ack, client }) => {
    await ack();
    if (!isAllowed(body.user.id)) return;

    const value = (body as any).actions?.[0]?.value || "";
    const [sessionId, requestId] = value.split(":");

    try {
      await agentloop.respondHITL(sessionId, requestId, "deny");
      if ("message" in body && "channel" in body) {
        await client.chat.update({
          channel: (body as any).channel.id,
          ts: (body as any).message.ts,
          text: `Denied by <@${body.user.id}>`,
          blocks: [],
        });
      }
    } catch (err) {
      logger.error("Failed to deny HITL", { error: (err as Error).message });
    }
  });

  app.action("hitl_abort", async ({ body, ack, client }) => {
    await ack();
    if (!isAllowed(body.user.id)) return;

    const value = (body as any).actions?.[0]?.value || "";
    const [sessionId] = value.split(":");

    try {
      await agentloop.abortTask(sessionId);
      if ("message" in body && "channel" in body) {
        await client.chat.update({
          channel: (body as any).channel.id,
          ts: (body as any).message.ts,
          text: `Aborted by <@${body.user.id}>`,
          blocks: [],
        });
      }
    } catch (err) {
      logger.error("Failed to abort task", { error: (err as Error).message });
    }
  });
}
