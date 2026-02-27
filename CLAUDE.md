# AgentLoop Slack Bridge — Development Guidelines

## What Is This Project

The Slack Bridge is a **thin transport layer** between Slack and the AgentLoop server. It translates Slack events, commands, and button clicks into AgentLoop JSON-RPC calls over a Unix socket, and streams AgentLoop events back to Slack as messages.

**The bridge owns ONLY:**
- Slack authentication (bot + app tokens)
- User allowlist and rate limiting
- Slack message formatting (Block Kit)
- Session-to-thread mapping (in-memory)

**The bridge owns NOTHING about:**
- Memory, context, compaction, prompt caching
- Sessions, agent logic, orchestration
- HITL decisions (just relays approve/deny/abort)
- Skills, tools, vault, pi management

If you find yourself adding logic that "decides" something about how the agent behaves, you are in the wrong repo. That belongs in the AgentLoop Go server at `~/development/agentloop`.

---

## Architecture

```
┌───────────────────────────────────┐
│  Slack Workspace                  │
│  DMs · @mentions · /commands      │
│  Block Kit buttons (HITL)         │
└────────────────┬──────────────────┘
                 │ WebSocket (Socket Mode, outbound only)
                 ▼
┌───────────────────────────────────┐
│  Slack Bridge (this repo)         │
│  Node.js · TypeScript · Bolt      │
│                                   │
│  Translates:                      │
│  • Slack message  → task.start    │
│  • Thread reply   → task.steer    │
│  • /abort         → task.abort    │
│  • HITL button    → hitl.respond  │
│  • AgentLoop events → Slack msgs  │
└────────────────┬──────────────────┘
                 │ Unix Socket (JSON-RPC 2.0, line-delimited)
                 ▼
┌───────────────────────────────────┐
│  AgentLoop Server (Go)            │
│  ~/development/agentloop          │
│  Handles ALL intelligence:        │
│  memory, sessions, HITL, vault,   │
│  skills, compaction, caching      │
└───────────────────────────────────┘
```

### Data Flow: Message → Task → Response

```
User sends DM in Slack
    │
    ▼
events.ts: app.message()
    ├─ 1. Check allowlist (security/allowlist.ts)
    ├─ 2. Check rate limit (security/rate-limiter.ts)
    ├─ 3. If thread reply to existing session → agentloop.steerTask()
    ├─ 4. Otherwise → agentloop.startTask(userId, text, workDir, "slack")
    │      Returns: { sessionId, status: "started" }
    ├─ 5. Store sessionId ↔ {channelId, threadTs} in SessionMap
    ├─ 6. Register event listeners on AgentLoopClient for this sessionId
    │
    ▼
AgentLoop server processes task, streams events:
    │
    ├─ event.text      → buffer chunks, flush to Slack every ~1s via chat.update
    ├─ event.tool_use  → post "Using tool: `toolName`" in thread
    ├─ event.hitl_request → post Block Kit buttons (Approve/Deny/Abort)
    ├─ event.done      → post final result with stats, upload file if >3500 chars
    ├─ event.error     → post error message
    │
    ▼
On event.done or event.error:
    ├─ Flush text buffer
    ├─ Update reactions (eyes → check/x)
    ├─ Remove event listeners (cleanup)
    └─ Remove from SessionMap
```

### HITL (Human-in-the-Loop) Flow

```
AgentLoop sends event.hitl_request
    │ { sessionId, requestId, toolName, details, options }
    ▼
events.ts → posts Block Kit message with 3 buttons:
    │ [Approve] [Deny] [Abort Task]
    │ Button value = "sessionId:requestId"
    ▼
User clicks button in Slack
    │
    ▼
actions.ts → parses value, calls:
    │ agentloop.respondHITL(sessionId, requestId, "approve"|"deny")
    │ OR agentloop.abortTask(sessionId)
    ▼
Updates original message: "Approved by @user" (buttons removed)
```

---

## Directory Structure

```
agentloop-slack/
├── package.json                 # Dependencies: @slack/bolt, zod, dotenv
├── tsconfig.json                # ES2022, NodeNext, strict
├── ecosystem.config.cjs         # PM2 deployment config
├── .env.example                 # Template for env vars
├── .gitignore
│
├── src/
│   ├── index.ts                 # Entry: connect AgentLoop → start Bolt → register handlers
│   ├── config.ts                # Zod-validated env config with ~ expansion
│   │
│   ├── agentloop/
│   │   ├── types.ts             # JSON-RPC 2.0 types, all RPC param/result/event types
│   │   └── client.ts            # Unix socket client (EventEmitter, reconnection, request correlation)
│   │
│   ├── slack/
│   │   ├── events.ts            # message.im + app_mention → task.start/steer + event streaming
│   │   ├── commands.ts          # /weather, /calendar, /task, /sessions, /abort
│   │   ├── actions.ts           # HITL button clicks → hitl.respond / task.abort
│   │   ├── blocks.ts            # Block Kit builders (HITL prompt, task result, session list)
│   │   └── session-map.ts       # Bidirectional sessionId ↔ Slack thread mapping
│   │
│   ├── security/
│   │   ├── allowlist.ts         # Fail-closed user allowlist
│   │   └── rate-limiter.ts      # Sliding window per-user rate limiter
│   │
│   ├── integrations/
│   │   ├── weather.ts           # OpenWeatherMap direct call (no agent)
│   │   └── calendar.ts          # Google Calendar stub (no agent)
│   │
│   └── utils/
│       └── logger.ts            # Structured JSON logger with level filtering
│
└── test/
    ├── client.test.ts           # AgentLoopClient tests (socket mock, RPC, events, errors)
    └── session-map.test.ts      # SessionMap tests (CRUD, cleanup, bidirectional lookup)
```

### Dependency Graph

```
index.ts
├── config.ts (zod, dotenv)
├── utils/logger.ts
├── agentloop/client.ts
│   ├── agentloop/types.ts
│   └── utils/logger.ts
├── slack/session-map.ts
├── slack/events.ts
│   ├── agentloop/client.ts
│   ├── agentloop/types.ts
│   ├── slack/blocks.ts (@slack/types for KnownBlock)
│   ├── slack/session-map.ts
│   ├── security/allowlist.ts
│   ├── security/rate-limiter.ts
│   └── utils/logger.ts
├── slack/commands.ts
│   ├── security/allowlist.ts
│   ├── security/rate-limiter.ts
│   ├── slack/blocks.ts
│   ├── integrations/weather.ts
│   └── integrations/calendar.ts
└── slack/actions.ts
    ├── agentloop/client.ts
    ├── security/allowlist.ts
    └── utils/logger.ts
```

---

## Prerequisites

- **Node.js** >= 20
- **npm** (comes with Node)
- **AgentLoop server** running and listening on its Unix socket

---

## Build & Run

```bash
# Install dependencies
npm install

# Development (auto-reload)
npm run dev

# Type check only
npm run typecheck

# Build for production
npm run build

# Run production build
npm start

# Run via PM2
pm2 start ecosystem.config.cjs
```

---

## Testing

```bash
# Run ALL tests (do this before any commit or PR)
npm test

# Watch mode during development
npm run test:watch

# Type check (also do before finishing work)
npm run typecheck
```

**Tests MUST pass before any work is considered done.** If you modify code, run `npm test` and `npm run typecheck` before finishing.

### Existing Tests

| Test File | Tests | What It Covers |
|-----------|-------|----------------|
| `test/client.test.ts` | 5 | RPC request/response, event emission, error handling, disconnect |
| `test/session-map.test.ts` | 4 | Bidirectional CRUD, cleanup callback, listing |

### Test Conventions

- **Framework:** Vitest
- **Test files:** `test/*.test.ts` (not colocated with source)
- **Pattern:** Create mock Unix socket servers for client tests. Use `node:net.createServer()` on temp socket paths.
- **Naming:** `describe("ClassName/moduleName", () => { it("does specific behavior", ...) })`
- When adding a new module, add corresponding tests. When modifying existing behavior, update or add tests to cover the change.

---

## Dependencies

```
@slack/bolt    ^4.1.0    Slack app framework (Socket Mode, events, commands, actions)
dotenv         ^16.4.7   .env file loading
zod            ^3.24.0   Config schema validation
```

Dev dependencies: `typescript`, `@types/node`, `tsx`, `vitest`

**Do NOT add dependencies without good reason.** This project intentionally has a minimal footprint. If you need a utility, check if Node.js built-ins or existing deps already provide it. For example:
- HTTP requests: use `fetch` (built-in since Node 18), not axios
- UUID generation: use `crypto.randomUUID()`, not uuid package
- File operations: use `node:fs`, not fs-extra
- Path operations: use `node:path` and `node:os`, not third-party

---

## AgentLoop Server Protocol Reference

The bridge communicates with the AgentLoop Go server over a **Unix domain socket** using **JSON-RPC 2.0** with **line-delimited JSON** (one JSON object per line, terminated by `\n`).

Default socket path: `~/.local/share/agentloop/agentloop.sock`

### Client → Server (Requests)

| Method | Params | Response |
|--------|--------|----------|
| `task.start` | `{userId, text, workDir?, source}` | `{sessionId, status: "started"}` |
| `task.steer` | `{sessionId, text}` | `{ok: true}` |
| `task.abort` | `{sessionId}` | `{ok: true}` |
| `hitl.respond` | `{sessionId, requestId, decision}` | `{ok: true}` |
| `session.list` | `{userId?, status?}` | `SessionInfo[]` |
| `memory.get` | `{userId}` | `{context}` |
| `memory.update` | `{userId, key, value}` | `{ok: true}` |
| `health.check` | `{}` | `{status: "ok", activeSessions: number}` |

### Server → Client (Event Notifications)

| Method | Params |
|--------|--------|
| `event.text` | `{sessionId, content}` |
| `event.tool_use` | `{sessionId, toolName, input}` |
| `event.tool_result` | `{sessionId, toolName, output, success}` |
| `event.hitl_request` | `{sessionId, requestId, toolName, details, options}` |
| `event.done` | `{sessionId, output, stats: {tokens, toolCalls, duration}}` |
| `event.error` | `{sessionId, message}` |
| `event.session_saved` | `{sessionId}` |

### Key Protocol Details

- Client auto-subscribes to a session's events when `task.start` succeeds
- Client unsubscribes when `task.abort` succeeds
- Notifications have a `method` field but no `id` field
- Responses have an `id` field matching the request
- Error responses: `{jsonrpc: "2.0", id, error: {code, message}}`
- Error codes: `-32700` (parse), `-32601` (method not found), `-32602` (invalid params), `-32000` (server error)

**If you need to add a new RPC method or event type**, update `src/agentloop/types.ts` first, then add the convenience method to `AgentLoopClient`, then use it in the appropriate Slack handler. The types file is the single source of truth for the protocol on the bridge side.

---

## Module-by-Module Guide

### `src/agentloop/client.ts` — Unix Socket Client

The most critical file. Manages the single persistent connection to AgentLoop.

**Key internals:**
- `buffer: string` — accumulates partial data from socket until `\n` delimiter
- `pending: Map<id, {resolve, reject, timer}>` — correlates RPC responses to requests
- `nextId: number` — monotonically increasing request ID counter
- Emits events by method name: `"event.text"`, `"event.done"`, etc.
- Exponential backoff reconnection: 1s → 2s → 4s → ... → 30s max

**When modifying:**
- Never break the line-delimited JSON protocol. Each message is exactly one JSON object followed by `\n`.
- Always clean up pending requests on disconnect (`rejectAllPending()`).
- The `intentionalClose` flag prevents reconnection attempts during graceful shutdown.
- Request timeout is 30 seconds — adjust `REQUEST_TIMEOUT_MS` if needed but consider that agent tasks can take minutes (the request returns immediately with a sessionId; the long-running work comes via event notifications).

### `src/slack/events.ts` — Event Handlers (most complex Slack file)

Handles DMs and @mentions. The `setupSessionListeners()` function is the heart of the streaming logic.

**Key patterns:**
- Text chunks accumulate in `textChunks[]` array
- A debounce timer (`flushTimer`) calls `flushText()` every 1 second
- First flush creates a new Slack message (`chat.postMessage`), subsequent flushes update it (`chat.update`)
- On `event.done`: cancel timer, flush remaining text, post final result with Block Kit, upload file if output > 3500 chars
- All listeners are named functions (`onText`, `onToolUse`, `onHITL`, `onDone`, `onError`) so they can be removed with `client.off()`
- The `cleanup()` function removes all listeners and is called on done/error/abort

**When modifying:**
- Always filter events by `sessionId` in every listener — the client receives events for ALL active sessions.
- Always implement proper cleanup. If you add a new event listener, add it to the `cleanup()` function too.
- Never call Slack API methods without `.catch(() => {})` — failed API calls should not crash the bridge.

### `src/slack/blocks.ts` — Block Kit Builders

**Imports:** `KnownBlock` comes from `@slack/types` (NOT from `@slack/bolt`). `WebClient` comes from `@slack/web-api` (NOT from `@slack/bolt`). This is a known gotcha with the Bolt package — it re-exports these as namespaces, not as named exports.

**Slack text limits:**
- Block Kit section text: 3000 chars max (enforced by `truncate()`)
- Overall message text: 3500 chars max (enforced in events.ts)
- HITL details: truncated to 2000 chars

### `src/slack/session-map.ts` — Session ↔ Thread Mapping

Bidirectional in-memory map. Thread key format: `"channelId:threadTs"`.

**When modifying:**
- Always call `remove()` when a session ends — it triggers the cleanup callback which removes event listeners.
- The `cleanup` property is set by `setupSessionListeners()` in events.ts after the session is created.

### `src/slack/actions.ts` — HITL Button Handlers

Pure relay. Button `value` format: `"sessionId:requestId"`, split on `:`.

**Action IDs:** `hitl_approve`, `hitl_deny`, `hitl_abort` — these must match the `action_id` values in `blocks.ts`.

### `src/slack/commands.ts` — Slash Commands

Mix of direct integrations (weather, calendar) and AgentLoop relays (task, sessions, abort).

**When adding a new slash command:**
1. Register in Slack App configuration (API dashboard)
2. Add `app.command("/name", ...)` in this file
3. Always call `await ack()` first
4. Always check `isAllowed(command.user_id)`
5. For AgentLoop-relayed commands, check rate limit too

### `src/security/allowlist.ts` — User Access Control

**Fail-closed:** if `ALLOWED_USER_IDS` is empty, ALL users are denied. This is intentional.

### `src/security/rate-limiter.ts` — Rate Limiting

Sliding window algorithm. In-memory — resets on process restart. The timestamps map is never cleaned up for inactive users, but this is acceptable for a single-machine deployment with a small allowlist.

### `src/config.ts` — Configuration

Uses Zod for runtime validation. The `AGENTLOOP_SOCKET` path has `~` expanded to `os.homedir()` at parse time.

**When adding a new config field:**
1. Add to the `ConfigSchema` object in `config.ts`
2. Add to `.env.example` with a comment
3. Use `z.string().optional()` or `.default()` for optional fields
4. If it's a path, add `.transform(p => p.replace(/^~/, homedir()))` for tilde expansion
5. Access via `config.FIELD_NAME` anywhere config is imported

### `src/integrations/` — Direct Integrations

These bypass the agent entirely for fast, simple responses.

**When adding a new integration:**
1. Create `src/integrations/myservice.ts`
2. Export an async function that returns a formatted string
3. Check for the API key in config (return "not configured" message if missing)
4. Add the API key to `ConfigSchema` in `config.ts` as optional
5. Add the API key to `.env.example`
6. Add a slash command in `commands.ts` that calls your function
7. Register the slash command in Slack App configuration

---

## Constants Reference

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `REQUEST_TIMEOUT_MS` | 30,000 | client.ts | RPC request timeout (ms) |
| `RECONNECT_BASE_MS` | 1,000 | client.ts | Initial reconnect delay (ms) |
| `RECONNECT_MAX_MS` | 30,000 | client.ts | Max reconnect delay (ms) |
| `TEXT_FLUSH_INTERVAL_MS` | 1,000 | events.ts | Text streaming debounce (ms) |
| `MAX_SLACK_TEXT` | 3,500 | events.ts | Max chars before file upload |
| `MAX_TEXT_LENGTH` | 3,000 | blocks.ts | Block Kit text truncation limit |
| `windowMs` | 60,000 | rate-limiter.ts | Rate limit window (1 minute) |
| Default `RATE_LIMIT_PER_MINUTE` | 20 | config.ts | Requests per user per minute |

---

## Common Development Tasks

### Adding a New Slack Event Handler

1. Add handler in `src/slack/events.ts` using `app.event("event_name", ...)`
2. Check allowlist and rate limit
3. Call the appropriate AgentLoop RPC method
4. Handle errors gracefully (`.catch(() => {})` on Slack API calls)
5. Add the event subscription in Slack App configuration if needed

### Adding a New AgentLoop Event Type

1. Add the event params interface in `src/agentloop/types.ts`
2. Add it to the `AgentEvent` discriminated union in the same file
3. Add a listener in `setupSessionListeners()` in `events.ts`
4. Add the listener to the `cleanup()` function
5. Update tests if the event affects observable behavior

### Adding a New RPC Method

1. Add param and result types in `src/agentloop/types.ts`
2. Add a convenience method on `AgentLoopClient` in `client.ts`
3. Use it from the appropriate Slack handler
4. Add a test in `test/client.test.ts` verifying the request format

### Adding a New Slash Command

1. Register the command in Slack App configuration (API dashboard)
2. Add `app.command("/name", ...)` in `src/slack/commands.ts`
3. Always: `await ack()` first, then `isAllowed()` check
4. If it calls AgentLoop, also check `checkRateLimit()`
5. Use `respond()` for ephemeral replies

### Adding a New HITL Action

1. Add the button in `buildHITLPrompt()` in `blocks.ts` with a unique `action_id`
2. Add the handler in `actions.ts` with matching `app.action("action_id", ...)`
3. Parse the button `value` (format: `"sessionId:requestId"`)
4. Call the appropriate AgentLoop method
5. Update the original message to reflect the action taken

### Coordinating with AgentLoop Server Changes

This bridge is developed in isolation. However, larger changes to the AgentLoop Go server (new RPC methods, changed event shapes, new protocol features) may require coordinated updates:

1. Check the AgentLoop CLAUDE.md at `~/development/agentloop/CLAUDE.md` for the current protocol spec
2. Update `src/agentloop/types.ts` to match any protocol changes
3. The types file is the bridge's contract with the server — if types match the Go server, everything works

---

## Gotchas & Pitfalls

### Import Paths

1. **All local imports MUST use `.js` extension** — this is required by NodeNext module resolution. Write `import { foo } from "./bar.js"` even though the source file is `bar.ts`. Omitting `.js` will cause runtime errors.

2. **`KnownBlock` is imported from `@slack/types`**, NOT from `@slack/bolt`. The Bolt package re-exports `@slack/types` as a namespace (`types`), not as named exports. Same for `WebClient` — import it from `@slack/web-api`.

   ```typescript
   // CORRECT
   import type { KnownBlock } from "@slack/types";
   import type { WebClient } from "@slack/web-api";

   // WRONG — will cause TS2614
   import type { KnownBlock } from "@slack/bolt";
   import type { WebClient } from "@slack/bolt";
   ```

3. **`App` IS imported from `@slack/bolt`** — only `App` and a few other Bolt-specific types come from the main package.

### Slack API Quirks

4. **Always `.catch(() => {})` on non-critical Slack API calls** (reactions, thread messages). Slack rate limits or permissions issues should never crash the bridge.

5. **`event.user` on `app_mention` can be undefined.** Always extract it to a variable and null-check before using:
   ```typescript
   const user = event.user;
   if (!user) return;
   ```

6. **`thread_ts` does not exist on all event types.** Use `"thread_ts" in event` guard before accessing it on app_mention events.

7. **Slack Block Kit section text limit is 3000 characters.** The overall message `text` field can be longer, but individual blocks cannot. Always use `truncate()` from `blocks.ts`.

8. **`chat.update` requires both `channel` and `ts`** — not `thread_ts`. The `ts` is the timestamp of the specific message to update, not the thread parent.

### AgentLoop Client

9. **Event listeners fire for ALL sessions** on the single socket connection. Every listener MUST filter by `sessionId`:
   ```typescript
   // CORRECT
   const onText = (p: TextEventParams) => {
     if (p.sessionId !== sessionId) return;
     // handle
   };

   // WRONG — will process events for other sessions
   const onText = (p: TextEventParams) => {
     // handle without checking sessionId
   };
   ```

10. **Always clean up event listeners.** If you add a listener with `agentloop.on()`, you MUST remove it with `agentloop.off()` when the session ends. Leaking listeners will cause memory issues and duplicate processing. Add every new listener to the `cleanup()` function in `setupSessionListeners()`.

11. **`task.start` returns immediately** with `{sessionId, status}`. The actual agent work happens asynchronously and results arrive as event notifications. Do not wait for the task to complete after calling `startTask()`.

12. **Socket reconnection loses all subscriptions.** The Go server creates a new `Client` object on reconnect. Active sessions continue running on the server, but the bridge will not receive their events. There is no `session.subscribe` RPC method to reattach.

### TypeScript

13. **`satisfies` keyword is used in client.ts** for type-checking RPC params without widening the type. Do not replace it with `as` — `satisfies` catches errors at compile time, `as` does not.

14. **The `Config` type is inferred from Zod** via `z.infer<typeof ConfigSchema>`. Do not duplicate the type manually — add fields to the schema and the type updates automatically.

15. **Config is parsed at module load time** (`config.ts` top-level). This means importing config in tests will fail unless env vars are set. Mock at the function level or set test env vars.

### Session Map

16. **`SessionMap.remove()` calls the cleanup callback.** Do not manually call `cleanup()` AND `remove()` — `remove()` already handles it. Calling cleanup twice is safe (guarded by `cleaned` flag) but unnecessary.

17. **Thread key format is `"channelId:threadTs"`.** Do not change this format — it must be consistent across set/get operations.

### Rate Limiter

18. **Rate limiter state is in-memory.** It resets on process restart. This is acceptable for this deployment model.

19. **The rate limiter never cleans up entries for inactive users.** For a small allowlist this is fine. If the allowlist grows large, consider adding periodic cleanup.

### General

20. **This is an ESM project** (`"type": "module"` in package.json). All imports must use ESM syntax. Do not use `require()`.

21. **`parseWorkDir()` is duplicated** in `events.ts` and `commands.ts`. This is intentional — each module is self-contained. If you need to change the pattern, update both.

22. **The bridge runs on the same machine as the AgentLoop server.** The Unix socket path uses tilde expansion (`~` → home dir) at config parse time. Do not hardcode absolute paths.

23. **PM2 deployment** uses `ecosystem.config.cjs` (CommonJS, not ESM). The `.cjs` extension is required because PM2 does not support ESM config files.

---

## Code Style

- TypeScript strict mode. No `any` unless interfacing with untyped Slack API internals (use `(body as any)` pattern sparingly in actions.ts).
- All files use named exports (no default exports).
- Error handling: wrap Slack API calls with `.catch(() => {})` for non-critical operations. Let critical errors (socket connection, config validation) propagate.
- Logging: use `logger.info/warn/error/debug()` from `utils/logger.ts`, not `console.log`.
- Constants: UPPER_SNAKE_CASE at module level for magic numbers.
- No emoji in code comments or log messages. Slack-facing messages may use emoji sparingly as defined in the existing handlers.

---

## Deployment

This project runs locally via PM2 alongside the AgentLoop Go server.

```bash
# Build
npm run build

# Start via PM2
pm2 start ecosystem.config.cjs

# Check status
pm2 status
pm2 logs agentloop-slack

# Restart after changes
npm run build && pm2 restart agentloop-slack
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `SLACK_BOT_TOKEN` | Yes | Starts with `xoxb-` |
| `SLACK_APP_TOKEN` | Yes | Starts with `xapp-` |
| `ALLOWED_USER_IDS` | Yes | Comma-separated Slack user IDs |
| `AGENTLOOP_SOCKET` | No | Default: `~/.local/share/agentloop/agentloop.sock` |
| `OPENWEATHER_API_KEY` | No | For /weather command |
| `GOOGLE_CALENDAR_CREDENTIALS` | No | For /calendar command |
| `RATE_LIMIT_PER_MINUTE` | No | Default: 20 |
| `LOG_LEVEL` | No | Default: info |

### Slack App Configuration

Required settings in the Slack API dashboard:

- **Socket Mode:** ON (generates `xapp-` token)
- **Bot Token Scopes:** `app_mentions:read`, `chat:write`, `commands`, `im:history`, `im:read`, `im:write`, `files:write`, `reactions:write`, `users:read`
- **Event Subscriptions:** `app_mention`, `message.im`
- **Slash Commands:** `/weather`, `/calendar`, `/task`, `/sessions`, `/abort`
- **Interactivity:** ON (for Block Kit button actions)
