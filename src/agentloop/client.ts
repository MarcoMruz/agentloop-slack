import { createConnection, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import type {
  RPCRequest,
  RPCResponse,
  RPCNotification,
  TaskStartParams,
  TaskStartResult,
  TaskSteerParams,
  TaskAbortParams,
  HITLRespondParams,
  SessionListParams,
  SessionInfo,
  HealthCheckResult,
  OkResult,
  FeedbackSubmitParams,
  FeedbackSubmitResult,
} from "./types.js";
import { logger } from "../utils/logger.js";

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * AgentLoopClient connects to the AgentLoop server over a Unix socket.
 * It sends JSON-RPC 2.0 requests and receives streamed event notifications.
 *
 * This is the ONLY integration point with AgentLoop.
 * The bridge never makes decisions — it just relays.
 */
export class AgentLoopClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_BASE_MS;
  private intentionalClose = false;

  constructor(private socketPath: string) {
    super();
  }

  async connect(): Promise<void> {
    this.intentionalClose = false;

    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath, () => {
        logger.info("Connected to AgentLoop server", { socket: this.socketPath });
        this.reconnectDelay = RECONNECT_BASE_MS;
        resolve();
      });

      this.socket.on("data", (data) => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as RPCResponse | RPCNotification;
            this.handleMessage(msg);
          } catch {
            logger.warn("Failed to parse message from AgentLoop", {
              line: line.slice(0, 200),
            });
          }
        }
      });

      this.socket.on("error", (err) => {
        logger.error("Socket error", { error: err.message });
        reject(err);
      });

      this.socket.on("close", () => {
        logger.warn("Disconnected from AgentLoop server");
        this.rejectAllPending("Socket closed");
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private handleMessage(msg: RPCResponse | RPCNotification) {
    // Response to a request (has id)
    if ("id" in msg && msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if ("error" in msg && msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve((msg as RPCResponse).result);
        }
      }
      return;
    }

    // Notification (event from server, no id)
    if ("method" in msg) {
      const notification = msg as RPCNotification;
      this.emit("event", notification);
      this.emit(notification.method, notification.params);
    }
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  async request<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("Not connected to AgentLoop server");
    }

    const id = this.nextId++;
    const req: RPCRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      this.socket!.write(JSON.stringify(req) + "\n");
    });
  }

  // --- Convenience methods ---

  async startTask(userId: string, text: string, workDir?: string, source = "slack", conversationContextId?: string) {
    return this.request<TaskStartResult>("task.start", {
      userId,
      text,
      ...(workDir && { workDir }),
      source,
      ...(conversationContextId && { conversationContextId }),
    } satisfies TaskStartParams);
  }

  async steerTask(sessionId: string, text: string) {
    return this.request<OkResult>("task.steer", {
      sessionId,
      text,
    } satisfies TaskSteerParams);
  }

  async abortTask(sessionId: string) {
    return this.request<OkResult>("task.abort", {
      sessionId,
    } satisfies TaskAbortParams);
  }

  async respondHITL(sessionId: string, requestId: string, decision: string) {
    return this.request<OkResult>("hitl.respond", {
      sessionId,
      requestId,
      decision,
    } satisfies HITLRespondParams);
  }

  async listSessions(userId?: string, status?: string) {
    return this.request<SessionInfo[]>("session.list", {
      ...(userId && { userId }),
      ...(status && { status }),
    } satisfies SessionListParams);
  }

  async healthCheck() {
    return this.request<HealthCheckResult>("health.check", {});
  }

  async submitFeedback(params: FeedbackSubmitParams) {
    return this.request<FeedbackSubmitResult>("feedback.submit", params as unknown as Record<string, unknown>);
  }

  // --- Reconnection ---

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    logger.info("Scheduling reconnect", { delayMs: this.reconnectDelay });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
        this.emit("reconnected");
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private rejectAllPending(reason: string) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  async disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending("Client disconnecting");
    this.socket?.destroy();
    this.socket = null;
  }
}
