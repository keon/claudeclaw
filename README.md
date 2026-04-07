<p align="center">
  <img src="assets/logo.png" width="200" alt="claudeclaw" />
</p>

<h1 align="center">claudeclaw</h1>

<p align="center">Multi-channel Claude Code agent harness — Telegram, Slack, and more.</p>

claudeclaw uses [Claude Code channels](https://code.claude.com/docs/en/channels-reference) to bridge messaging platforms directly into a Claude Code session. Instead of spawning a CLI subprocess per message, each channel runs as an MCP server **inside** the session — giving Claude full access to tools, context, MCP servers, and conversation history natively.

## Why

Existing claw implementations suffer from fundamental issues:

- **openclaw** — Telegram communication is unstable. Typing indicators drop, long tasks lose responses entirely.
- **zero-claw** — Tool calling results don't persist in context, so the agent uses tools poorly.

These problems come from building agent harnesses from scratch. claudeclaw solves them by using **Claude Code itself** as the engine. Session management, tool calling, context compaction, MCP support — all handled by Claude Code's battle-tested infrastructure.

## Architecture

```
Claude Code session
  ├── claudeclaw-telegram  (MCP channel, grammy long-polling)
  ├── claudeclaw-slack     (MCP channel, Bolt Socket Mode)
  └── src/lib/             (shared)
        ├── access.ts       — pairing flow + allowlist
        ├── permissions.ts  — remote tool approval from phone
        ├── files.ts        — inbox/outbox (50MB limit)
        ├── chunker.ts      — platform-aware message splitting
        ├── logging.ts      — structured JSON logs per event
        ├── channel-cron.ts — scheduled prompt system
        └── heartbeat.ts    — periodic agent check-ins
```

## Setup

```bash
git clone https://github.com/keon/claudeclaw.git
cd claudeclaw
bun install
cp .env.example .env.local
```

Edit `.env.local` with your tokens, then start a channel.

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Add your token to `.env.local`:
   ```
   TELEGRAM_BOT_TOKEN=your-token-here
   ```
3. Start Claude Code with the channel:
   ```bash
   claude --dangerously-load-development-channels server:claudeclaw-telegram
   ```
4. DM your bot — it will ask you to pair. Run the pairing command in your Claude Code session.

### Slack

1. Create a Slack app at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** — generate an app-level token (`xapp-...`) with `connections:write` scope
3. Add **Bot Token Scopes**: `chat:write`, `reactions:write`, `files:write`, `files:read`, `users:read`, `im:history`, `channels:history`
4. Enable **Event Subscriptions** — subscribe to `message.im` (and `message.channels` for channels)
5. Install to your workspace and copy the bot token (`xoxb-...`)
6. Add tokens to `.env.local`:
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```
7. Start Claude Code with the channel:
   ```bash
   claude --dangerously-load-development-channels server:claudeclaw-slack
   ```
8. DM your bot — pair via the command shown, then you're connected.

### Multiple channels

Run both simultaneously:

```bash
claude --dangerously-load-development-channels server:claudeclaw-telegram server:claudeclaw-slack
```

## Features

| Feature | Telegram | Slack |
|---------|----------|-------|
| **reply** | Auto-chunks at 4096 chars, photo/doc attachments | Auto-chunks at 3000 chars, file upload |
| **react** | Emoji reactions | Slack emoji names |
| **edit_message** | Edit sent messages | Edit by timestamp |
| **download_attachment** | By file_id | Auto-download on receive |
| **Permission relay** | Approve/deny tool use via DM | Approve/deny tool use via DM |
| **Access control** | Pairing codes | Pairing codes |
| **Typing indicator** | Shows "typing..." while Claude works | — |
| **Album coalescing** | Groups multi-photo albums into one message | — |
| **Reply context** | Includes original message when replying | — |
| **Structured logging** | JSON logs per event | JSON logs per event |
| **Cron jobs** | Scheduled prompts | Scheduled prompts |
| **Heartbeat** | Periodic check-ins | Periodic check-ins |

## Heartbeat

Heartbeat runs periodic agent check-ins so Claude can surface anything that needs attention without you asking. Modeled after [OpenClaw's heartbeat system](https://github.com/nicepkg/openclaw).

Create `~/.claude-claw/HEARTBEAT.md` with a checklist:

```markdown
# Heartbeat checklist

- Check if any background tasks completed
- Scan for anything urgent the user should know
- If daytime, do a lightweight check-in if nothing else is pending
```

**Protocol:** If nothing needs attention, Claude replies `HEARTBEAT_OK` which is suppressed (no spam). Actual alerts are delivered normally.

**Configuration** (env vars in `.env.local`):

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_CLAW_HEARTBEAT_INTERVAL` | `30m` | How often to run (`5m`, `30m`, `1h`, etc.) |
| `CLAUDE_CLAW_HEARTBEAT_HOURS` | _(24/7)_ | Active hours, e.g. `09:00-22:00` |

## Cron jobs

Create JSON files in `~/.claude-claw/cronjobs/` to schedule prompts.

**Time-based** (runs daily at a specific time):

```json
{
  "id": "daily-summary",
  "time": "09:00",
  "action": { "type": "message", "prompt": "Give me a morning summary of open PRs" }
}
```

**Interval-based** (runs every N seconds/minutes/hours):

```json
{
  "id": "status-check",
  "interval": "5m",
  "action": { "type": "message", "prompt": "Quick status check on running deployments" }
}
```

**One-shot** (runs once at a specific date/time, then auto-disables):

```json
{
  "id": "reminder",
  "time": "14:00",
  "date": "2026-04-07",
  "action": { "type": "message", "prompt": "Remind me to ship the release" }
}
```

Interval formats: `30s`, `5m`, `1h`. Time format: `HH:MM`. Date format: `YYYY-MM-DD`.

## Memory

Claude Code has a built-in memory system that persists across sessions. claudeclaw channels instruct Claude to save important facts, preferences, and decisions from chat conversations automatically — ensuring continuity even after context compaction.

No extra configuration needed. Claude manages its own memory at `~/.claude/projects/*/memory/`.

## What you get for free from Claude Code

- Full tool calling (Bash, Read, Write, Edit, Grep, Glob...)
- Session and context management
- Automatic context compaction
- MCP server support
- CLAUDE.md project instructions
- Hooks system
- Built-in memory persistence
- 100% compatibility with Claude Code extensions (oh-my-claudecode, etc.)

## Adding a new channel

Each channel is a single `server.ts` file that:

1. Creates an MCP server with `claude/channel` capability
2. Connects to the messaging platform (polling, WebSocket, etc.)
3. Emits `notifications/claude/channel` when messages arrive
4. Exposes tools (`reply`, `react`, `edit_message`) for Claude to respond

See the [channels reference](https://code.claude.com/docs/en/channels-reference) for the full contract.

## License

MIT
