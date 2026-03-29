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

// New optional fields (filePath, whitelistedPaths, structuredInput,
// riskLevel, reason, toolCategory) are populated by the Go server's
// security extension starting from protocol version TBD.
// See ~/development/agentloop for server-side implementation.
export interface HITLRequestEventParams {
  sessionId: string;
  requestId: string;
  toolName: string;        // human-readable tool label
  details: string;         // free-text description (may equal toolName)
  options: string[];       // approve/deny/etc choices

  // Existing optional fields
  command?: string;        // raw command / file path / URL
  workDir?: string;        // cwd at time of request
  rule?: string;           // security rule name that fired
  method?: string;         // sub-method within the rule

  // Enriched context fields (populated by Go server when available)
  toolCategory?: "file" | "bash" | "network" | "process" | "other";
  filePath?: string;       // the specific file/dir path (for file tools)
  whitelistedPaths?: string[];  // paths that ARE allowed (for context)
  structuredInput?: Record<string, unknown>; // parsed tool input key/values
  riskLevel?: "low" | "medium" | "high";    // severity hint from server
  reason?: string;         // one-line human explanation of why blocked
}

// Emitted by the Go server when a HITL request was automatically approved
// by the security policy (riskLevel is "low" or "medium" and AutoApproveNonHigh
// is enabled). This is a separate event from event.hitl_request.
export interface HITLAutoApprovedEventParams {
  sessionId: string;
  requestId: string;
  toolName: string;
  riskLevel: string;       // "low" | "medium"
  command: string;
  rule: string;
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
  | { method: "event.hitl_auto_approved"; params: HITLAutoApprovedEventParams }
  | { method: "event.done"; params: DoneEventParams }
  | { method: "event.error"; params: ErrorEventParams }
  | { method: "event.session_saved"; params: SessionSavedEventParams };
