# AgentLoop Slack Bridge

A thin transport layer that connects [AgentLoop](https://github.com/user/agentloop) to Slack. Send messages, run agent tasks, approve tool executions — all from Slack DMs, @mentions, and slash commands.

```
Slack Workspace ──(Socket Mode)──> Slack Bridge ──(Unix Socket)──> AgentLoop Server
                                   (this repo)                     (Go, all intelligence)
```

The bridge has zero intelligence. It translates Slack events into AgentLoop JSON-RPC calls and streams agent events back as Slack messages. All memory, context management, session logic, HITL decisions, skills, and agent orchestration live in the AgentLoop server.

## What You Can Do

| Action | How | What Happens |
|--------|-----|-------------|
| Start a task | DM the bot or @mention it | `task.start` via AgentLoop, streams output in thread |
| Steer a running task | Reply in the task's thread | `task.steer` redirects the agent |
| Approve/deny tool use | Click buttons in Slack | `hitl.respond` relays your decision |
| Abort a task | `/abort` or click Abort button | `task.abort` stops the agent |
| List sessions | `/sessions` | Shows your active agent sessions |
| Start task via command | `/task fix the login bug` | Same as DM, triggered from any channel |
| Check weather | `/weather Bratislava` | Direct API call, no agent involved |
| Specify work directory | DM: `in ~/myproject fix tests` | Agent runs in the given directory |

---

## Prerequisites

- **Node.js** >= 20
- **AgentLoop server** built and running (see [AgentLoop repo](https://github.com/user/agentloop))
- **Slack workspace** where you can create apps

---

## Setup Guide

### Step 1: Create the Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) and click **Create New App** > **From scratch**.

Give it a name (e.g., "AgentLoop") and select your workspace.

#### 1.1 Enable Socket Mode

1. Go to **Settings** > **Socket Mode**
2. Toggle **Enable Socket Mode** to ON
3. Create an app-level token with the `connections:write` scope
4. Name it anything (e.g., "socket-token")
5. Copy the token — it starts with `xapp-`. This is your `SLACK_APP_TOKEN`

#### 1.2 Add Bot Token Scopes

1. Go to **Features** > **OAuth & Permissions**
2. Under **Bot Token Scopes**, add these scopes:

| Scope | Purpose |
|-------|---------|
| `app_mentions:read` | Receive @mention events |
| `chat:write` | Send messages and updates |
| `commands` | Register slash commands |
| `im:history` | Read DM history |
| `im:read` | Access DM channels |
| `im:write` | Open DMs with users |
| `files:write` | Upload long outputs as files |
| `reactions:write` | Add/remove emoji reactions |
| `users:read` | Look up user info |

3. Click **Install to Workspace** (or reinstall if already installed)
4. Copy the **Bot User OAuth Token** — it starts with `xoxb-`. This is your `SLACK_BOT_TOKEN`

#### 1.3 Enable Event Subscriptions

1. Go to **Features** > **Event Subscriptions**
2. Toggle **Enable Events** to ON
3. Under **Subscribe to bot events**, add:
   - `app_mention` — triggers when someone @mentions the bot
   - `message.im` — triggers on direct messages to the bot

#### 1.4 Register Slash Commands

Go to **Features** > **Slash Commands** and create these commands:

| Command | Description | Usage Hint |
|---------|-------------|------------|
| `/task` | Start an agent task | `[in ~/path] description` |
| `/sessions` | List active sessions | |
| `/abort` | Abort running session | |
| `/weather` | Check weather | `city name` |
| `/calendar` | Check calendar | `today` |

#### 1.5 Enable Interactivity

1. Go to **Features** > **Interactivity & Shortcuts**
2. Toggle **Interactivity** to ON
3. No request URL is needed (Socket Mode handles it)

#### 1.6 Find Your Slack User ID

1. In Slack, click on your profile picture > **Profile**
2. Click the **...** menu > **Copy member ID**
3. This is the ID you'll add to `ALLOWED_USER_IDS`

### Step 2: Start the AgentLoop Server

Make sure the AgentLoop Go server is running and the Unix socket exists:

```bash
# Build the server (if not already done)
cd ~/development/agentloop
go build -o agentloop-server ./cmd/agentloop-server

# Start it
./agentloop-server &

# Verify the socket exists
ls -la ~/.local/share/agentloop/agentloop.sock

# Verify it responds
echo '{"jsonrpc":"2.0","id":1,"method":"health.check","params":{}}' | \
  socat - UNIX-CONNECT:~/.local/share/agentloop/agentloop.sock
```

You should see a response like `{"jsonrpc":"2.0","id":1,"result":{"status":"ok","activeSessions":0}}`.

### Step 3: Configure the Bridge

```bash
cd ~/development/agentloop-slack

# Copy the example env file
cp .env.example .env
```

Edit `.env` with your values:

```bash
# From Step 1.2 — Bot User OAuth Token
SLACK_BOT_TOKEN=xoxb-your-actual-token

# From Step 1.1 — App-Level Token
SLACK_APP_TOKEN=xapp-your-actual-token

# From Step 1.6 — Your Slack user ID(s), comma-separated
ALLOWED_USER_IDS=U0123ABCDEF

# AgentLoop socket path (default is usually correct)
AGENTLOOP_SOCKET=~/.local/share/agentloop/agentloop.sock

# Optional: OpenWeatherMap API key for /weather command
# OPENWEATHER_API_KEY=your-key

LOG_LEVEL=info
```

### Step 4: Install and Run

```bash
# Install dependencies
npm install

# Run in development mode (auto-reload on changes)
npm run dev
```

If everything is configured correctly, you'll see:

```
{"ts":"...","level":"info","msg":"Connected to AgentLoop server","socket":"/Users/you/.local/share/agentloop/agentloop.sock"}
{"ts":"...","level":"info","msg":"AgentLoop server healthy","status":"ok","activeSessions":0}
{"ts":"...","level":"info","msg":"Slack Bridge running (thin transport layer)"}
```

### Step 5: Test It

1. Open Slack and find your bot in the sidebar under **Apps** (or DM it directly)
2. Send it a message: `hello, what can you do?`
3. You should see:
   - An eyes emoji reaction (processing)
   - Streaming text responses in the thread
   - A final message with stats (tokens, tool calls, duration)
   - Eyes reaction replaced with a checkmark

If the bot doesn't appear in your sidebar, go to **Apps** in Slack and search for the bot name you chose in Step 1.

---

## Production Deployment

For long-running deployment, use PM2:

```bash
# Build the TypeScript
npm run build

# Start with PM2
pm2 start ecosystem.config.cjs

# Verify
pm2 status
pm2 logs agentloop-slack

# Auto-start on reboot
pm2 save
pm2 startup
```

To run both the AgentLoop server and the Slack bridge together, create a combined PM2 config or use the one from the [tech spec](./ecosystem.config.cjs).

```bash
# Restart after code changes
npm run build && pm2 restart agentloop-slack

# Stop
pm2 stop agentloop-slack
```

---

## Project Structure

```
agentloop-slack/
├── src/
│   ├── index.ts                 # Entry point: connects everything
│   ├── config.ts                # Environment config (Zod validated)
│   │
│   ├── agentloop/
│   │   ├── client.ts            # Unix socket JSON-RPC client
│   │   └── types.ts             # Protocol types (requests, responses, events)
│   │
│   ├── slack/
│   │   ├── events.ts            # DM + @mention handlers, event streaming
│   │   ├── commands.ts          # Slash command handlers
│   │   ├── actions.ts           # HITL button click handlers
│   │   ├── blocks.ts            # Block Kit message builders
│   │   └── session-map.ts       # Session ↔ Slack thread mapping
│   │
│   ├── security/
│   │   ├── allowlist.ts         # User access control
│   │   └── rate-limiter.ts      # Per-user rate limiting
│   │
│   ├── integrations/
│   │   ├── weather.ts           # OpenWeatherMap (direct, no agent)
│   │   └── calendar.ts          # Google Calendar (stub)
│   │
│   └── utils/
│       └── logger.ts            # Structured JSON logger
│
├── test/                        # Vitest tests
├── package.json
├── tsconfig.json
├── ecosystem.config.cjs         # PM2 config
├── .env.example                 # Environment template
└── CLAUDE.md                    # AI agent development guidelines
```

---

## Development

```bash
# Install dependencies
npm install

# Development with auto-reload
npm run dev

# Type check
npm run typecheck

# Run tests
npm test

# Build for production
npm run build
```

### Key Files to Understand First

If you're onboarding, read these files in this order:

1. **`src/agentloop/types.ts`** — The protocol contract. All RPC methods, event types, and data shapes.
2. **`src/agentloop/client.ts`** — How the bridge talks to AgentLoop. Unix socket, JSON-RPC, reconnection.
3. **`src/slack/events.ts`** — The main flow. How Slack messages become agent tasks and how events stream back.
4. **`src/slack/blocks.ts`** — How messages look in Slack. Block Kit builders for HITL prompts and results.
5. **`src/index.ts`** — How everything is wired together at startup.

For detailed development guidelines, module-by-module documentation, and common pitfalls, see [CLAUDE.md](./CLAUDE.md).

---

## Troubleshooting

### Bridge won't start: "SLACK_BOT_TOKEN must start with xoxb-"

Your `.env` file is missing or has placeholder values. Copy `.env.example` to `.env` and fill in real tokens from Step 1.

### Bridge won't start: "Socket error" / "ENOENT"

The AgentLoop server is not running or the socket path is wrong. Start the server first (Step 2) and verify the socket file exists at the path in your `.env`.

### Bot doesn't respond to messages

1. Check that your Slack user ID is in `ALLOWED_USER_IDS` in `.env`
2. Verify the bot has the correct scopes (Step 1.2) — reinstall the app after adding scopes
3. Check that `message.im` and `app_mention` events are subscribed (Step 1.3)
4. Check bridge logs: `pm2 logs agentloop-slack` or check terminal output in dev mode

### Bot reacts with eyes but never responds

The AgentLoop server may be stuck or crashed. Check its logs. The bridge connects and sends `task.start` successfully (hence the eyes reaction) but never receives `event.done`.

### "Rate limit exceeded" message

You're sending too many messages too quickly. Default is 20 per minute. Adjust `RATE_LIMIT_PER_MINUTE` in `.env` if needed.

### HITL buttons don't work

1. Verify **Interactivity** is enabled in the Slack app settings (Step 1.5)
2. Check that the clicking user's ID is in `ALLOWED_USER_IDS`

### Bridge disconnects and reconnects repeatedly

The AgentLoop server may be crashing. The bridge auto-reconnects with exponential backoff (1s → 30s). Check the server logs for errors.

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | Yes | — | Bot OAuth token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Yes | — | App-level token for Socket Mode (`xapp-...`) |
| `ALLOWED_USER_IDS` | Yes | — | Comma-separated Slack user IDs |
| `AGENTLOOP_SOCKET` | No | `~/.local/share/agentloop/agentloop.sock` | Path to AgentLoop Unix socket |
| `OPENWEATHER_API_KEY` | No | — | Enables `/weather` command |
| `GOOGLE_CALENDAR_CREDENTIALS` | No | — | Enables `/calendar` command |
| `RATE_LIMIT_PER_MINUTE` | No | `20` | Max requests per user per minute |
| `LOG_LEVEL` | No | `info` | Logging verbosity: debug, info, warn, error |
