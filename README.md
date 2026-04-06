# claudeclaw

Multi-channel Claude Code agent harness — Telegram, Slack, and more.

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
        └── cron/           — scheduled prompt system
```

## Setup

```bash
git clone https://github.com/keon/claudeclaw.git
cd claudeclaw
bun install
```

### Telegram

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Set your token:
   ```bash
   export TELEGRAM_BOT_TOKEN="your-token"
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
6. Set tokens:
   ```bash
   export SLACK_BOT_TOKEN="xoxb-..."
   export SLACK_APP_TOKEN="xapp-..."
   ```
7. Start Claude Code with the channel:
   ```bash
   claude --dangerously-load-development-channels server:claudeclaw-slack
   ```
8. DM your bot — pair via the command shown, then you're connected.

### Multiple channels

Run both simultaneously:

```bash
export TELEGRAM_BOT_TOKEN="..."
export SLACK_BOT_TOKEN="..."
export SLACK_APP_TOKEN="..."

claude --dangerously-load-development-channels server:claudeclaw-telegram server:claudeclaw-slack
```

## Channel features

| Feature | Telegram | Slack |
|---------|----------|-------|
| **reply** | Auto-chunks at 4096 chars, photo/doc attachments | Auto-chunks at 3000 chars, file upload |
| **react** | Emoji reactions | Slack emoji names |
| **edit_message** | Edit sent messages | Edit by timestamp |
| **download_attachment** | By file_id | Auto-download on receive |
| **Permission relay** | Approve/deny tool use via DM | Approve/deny tool use via DM |
| **Access control** | Pairing codes | Pairing codes |

## What you get for free from Claude Code

- Full tool calling (Bash, Read, Write, Edit, Grep, Glob...)
- Session and context management
- Automatic context compaction
- MCP server support
- CLAUDE.md project instructions
- Hooks system
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
