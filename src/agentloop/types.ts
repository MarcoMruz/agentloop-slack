// JSON-RPC 2.0 wire types (matches Go server in internal/server/server.go)

export interface RPCRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface RPCResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface RPCNotification {
  jsonrpc: "2.0";
  method: string;
  params: Record<string, unknown>;
}

// --- RPC request param types ---

export interface TaskStartParams {
  userId: string;
  text: string;
  workDir?: string;
  source?: string;
}

export interface TaskSteerParams {
  sessionId: string;
  text: string;
}

export interface TaskAbortParams {
  sessionId: string;
}

export interface HITLRespondParams {
  sessionId: string;
  requestId: string;
  decision: string;
}

export interface SessionListParams {
  userId?: string;
  status?: string;
}

// --- RPC response types ---

export interface TaskStartResult {
  sessionId: string;
  status: string;
}

export interface OkResult {
  ok: boolean;
}

export interface SessionInfo {
  id: string;
  task: string;
  state: string;
  userId?: string;
  createdAt?: string;
}

export interface HealthCheckResult {
  status: string;
  activeSessions: number;
}

// --- Event notification param types ---

export interface TextEventParams {
  sessionId: string;
  content: string;
}

export interface ToolUseEventParams {
  sessionId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultEventParams {
  sessionId: string;
  toolName: string;
  output: string;
  success: boolean;
}

export interface HITLRequestEventParams {
  sessionId: string;
  requestId: string;
  toolName: string;
  details: string;
  options: string[];
}

export interface DoneEventParams {
  sessionId: string;
  output: string;
  stats: {
    tokens: number;
    toolCalls: number;
    duration: string;
  };
}

export interface ErrorEventParams {
  sessionId: string;
  message: string;
}

export interface SessionSavedEventParams {
  sessionId: string;
}

// Discriminated union of all server events
export type AgentEvent =
  | { method: "event.text"; params: TextEventParams }
  | { method: "event.tool_use"; params: ToolUseEventParams }
  | { method: "event.tool_result"; params: ToolResultEventParams }
  | { method: "event.hitl_request"; params: HITLRequestEventParams }
  | { method: "event.done"; params: DoneEventParams }
  | { method: "event.error"; params: ErrorEventParams }
  | { method: "event.session_saved"; params: SessionSavedEventParams };
