import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AgentLoopClient } from "../src/agentloop/client.js";

function tmpSocket(): string {
  return join(tmpdir(), `test-${randomBytes(4).toString("hex")}.sock`);
}

describe("AgentLoopClient", () => {
  let server: Server;
  let socketPath: string;

  beforeEach(() => {
    socketPath = tmpSocket();
  });

  afterEach(async () => {
    server?.close();
  });

  it("sends JSON-RPC request and receives response", async () => {
    server = createServer((conn) => {
      conn.on("data", (data) => {
        const req = JSON.parse(data.toString().trim());
        expect(req.jsonrpc).toBe("2.0");
        expect(req.method).toBe("health.check");
        conn.write(
          JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { status: "ok", activeSessions: 0 } }) + "\n"
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new AgentLoopClient(socketPath);
    await client.connect();

    const result = await client.healthCheck();
    expect(result).toEqual({ status: "ok", activeSessions: 0 });

    await client.disconnect();
  });

  it("sends task.start with correct params", async () => {
    server = createServer((conn) => {
      conn.on("data", (data) => {
        const req = JSON.parse(data.toString().trim());
        expect(req.method).toBe("task.start");
        expect(req.params.userId).toBe("U123");
        expect(req.params.text).toBe("hello");
        expect(req.params.source).toBe("slack");
        conn.write(
          JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { sessionId: "sess-abc", status: "started" } }) + "\n"
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new AgentLoopClient(socketPath);
    await client.connect();

    const result = await client.startTask("U123", "hello");
    expect(result.sessionId).toBe("sess-abc");
    expect(result.status).toBe("started");

    await client.disconnect();
  });

  it("emits event notifications", async () => {
    server = createServer((conn) => {
      conn.on("data", (data) => {
        const req = JSON.parse(data.toString().trim());
        // Respond to the request
        conn.write(
          JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { sessionId: "sess-1", status: "started" } }) + "\n"
        );
        // Then send event notifications
        setTimeout(() => {
          conn.write(
            JSON.stringify({ jsonrpc: "2.0", method: "event.text", params: { sessionId: "sess-1", content: "Hello " } }) + "\n"
          );
          conn.write(
            JSON.stringify({ jsonrpc: "2.0", method: "event.done", params: { sessionId: "sess-1", output: "Hello world", stats: { tokens: 100, toolCalls: 1, duration: "2s" } } }) + "\n"
          );
        }, 50);
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new AgentLoopClient(socketPath);
    await client.connect();

    const events: any[] = [];
    client.on("event.text", (p) => events.push({ type: "text", ...p }));
    client.on("event.done", (p) => events.push({ type: "done", ...p }));

    await client.startTask("U123", "test");

    // Wait for events
    await new Promise((r) => setTimeout(r, 200));

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("text");
    expect(events[0].content).toBe("Hello ");
    expect(events[1].type).toBe("done");
    expect(events[1].stats.tokens).toBe(100);

    await client.disconnect();
  });

  it("handles RPC errors", async () => {
    server = createServer((conn) => {
      conn.on("data", (data) => {
        const req = JSON.parse(data.toString().trim());
        conn.write(
          JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32602, message: "userId required" } }) + "\n"
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new AgentLoopClient(socketPath);
    await client.connect();

    await expect(client.startTask("", "test")).rejects.toThrow("userId required");

    await client.disconnect();
  });

  it("rejects pending requests on disconnect", async () => {
    server = createServer(() => {
      // Server accepts but never responds
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new AgentLoopClient(socketPath);
    await client.connect();

    const promise = client.healthCheck();
    await client.disconnect();

    await expect(promise).rejects.toThrow("Client disconnecting");
  });
});
