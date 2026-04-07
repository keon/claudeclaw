#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { App, LogLevel } from "@slack/bolt";
import { checkAccess, loadAccessState } from "../src/lib/access";
import {
  PermissionRequestSchema,
  parsePermissionVerdict,
  emitPermissionVerdict,
  formatPermissionPrompt,
} from "../src/lib/permissions";
import { saveToInbox, assertSendable, readSendableFile } from "../src/lib/files";
import { chunkMessage } from "../src/lib/chunker";
import { createChannelLogger } from "../src/lib/logging";
import { createChannelCron } from "../src/lib/channel-cron";

const CHANNEL_NAME = "claudeclaw-slack";
const MAX_TEXT_LENGTH = 3000;
const logger = createChannelLogger(CHANNEL_NAME);

// --- Resolve tokens ---
const botToken = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;

if (!botToken || !appToken) {
  console.error("[claudeclaw-slack] SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required");
  process.exit(1);
}

// --- MCP Server ---
const mcp = new Server(
  { name: CHANNEL_NAME, version: "0.2.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions: [
      `Messages from Slack arrive as <channel source="${CHANNEL_NAME}" channel_id="..." sender_id="..." sender_name="..." thread_ts="..." message_ts="...">`,
      "The sender reads Slack, not this terminal.",
      "",
      "Available tools:",
      `- reply: Post a message to a Slack channel. Pass channel_id from the tag. For threaded replies, pass thread_ts. Text is auto-chunked at ${MAX_TEXT_LENGTH} chars.`,
      "- react: Add an emoji reaction. Use emoji name without colons (e.g. 'thumbsup', 'eyes').",
      "- edit_message: Edit a previously sent message using its timestamp.",
      "",
      "IMPORTANT: Always reply as a thread. Use the thread_ts from the channel tag — it is always provided.",
      "Keep replies concise. Use Slack mrkdwn formatting (*bold*, _italic_, `code`, ```code block```).",
    ].join("\n"),
  },
);

// --- Slack App (Socket Mode, stderr logger) ---
const stderrLogger = {
  debug: (...args: any[]) => {},
  info: (...args: any[]) => console.error("[slack]", ...args),
  warn: (...args: any[]) => console.error("[slack:warn]", ...args),
  error: (...args: any[]) => console.error("[slack:error]", ...args),
  getLevel: () => LogLevel.INFO as any,
  setLevel: () => {},
  setName: () => {},
};

const app = new App({
  token: botToken,
  appToken: appToken,
  socketMode: true,
  logger: stderrLogger as any,
});

// Get bot's own user ID to ignore self-messages
let botUserId: string | null = null;

// Track last active chat for cron delivery
let lastActiveChat: Record<string, string> | null = null;

// --- Tools ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Post a message to a Slack channel or thread",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string", description: "Slack channel ID (from the channel tag)" },
          text: { type: "string", description: "Message text (Slack mrkdwn supported)" },
          thread_ts: { type: "string", description: "Thread timestamp to reply in (optional)" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to upload (optional, max 50MB each)",
          },
        },
        required: ["channel_id", "text"],
      },
    },
    {
      name: "react",
      description: "Add an emoji reaction to a Slack message",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string", description: "Slack channel ID" },
          timestamp: { type: "string", description: "Message timestamp to react to" },
          emoji: { type: "string", description: "Emoji name without colons (e.g. thumbsup)" },
        },
        required: ["channel_id", "timestamp", "emoji"],
      },
    },
    {
      name: "edit_message",
      description: "Edit a previously sent Slack message",
      inputSchema: {
        type: "object" as const,
        properties: {
          channel_id: { type: "string", description: "Slack channel ID" },
          timestamp: { type: "string", description: "Message timestamp to edit" },
          text: { type: "string", description: "New message text" },
        },
        required: ["channel_id", "timestamp", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "reply") {
    const { channel_id, text, thread_ts, files } = args as {
      channel_id: string;
      text: string;
      thread_ts?: string;
      files?: string[];
    };

    const chunks = chunkMessage(text, { maxLength: MAX_TEXT_LENGTH });
    const timestamps: string[] = [];

    for (const chunk of chunks) {
      const result = await app.client.chat.postMessage({
        channel: channel_id,
        text: chunk,
        thread_ts: thread_ts,
      });
      if (result.ts) timestamps.push(result.ts);
    }

    // Upload files if any
    if (files && files.length > 0) {
      for (const filePath of files) {
        try {
          await assertSendable(CHANNEL_NAME, filePath);
          const { data, name: fileName } = await readSendableFile(filePath);
          const uploadArgs: Record<string, unknown> = {
            channel_id: channel_id,
            file: data,
            filename: fileName,
          };
          if (thread_ts) uploadArgs.thread_ts = thread_ts;
          await app.client.filesUploadV2(uploadArgs as any);
        } catch (error) {
          await app.client.chat.postMessage({
            channel: channel_id,
            text: `Failed to upload file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
            thread_ts: thread_ts,
          });
        }
      }
    }

    await logger.logOutbound({ chatId: channel_id, content: text, tool: "reply" });
    return {
      content: [{ type: "text", text: `Sent ${chunks.length} message(s), timestamps: ${timestamps.join(", ")}` }],
    };
  }

  if (name === "react") {
    const { channel_id, timestamp, emoji } = args as {
      channel_id: string;
      timestamp: string;
      emoji: string;
    };
    await app.client.reactions.add({
      channel: channel_id,
      timestamp: timestamp,
      name: emoji,
    });
    return { content: [{ type: "text", text: "Reacted" }] };
  }

  if (name === "edit_message") {
    const { channel_id, timestamp, text } = args as {
      channel_id: string;
      timestamp: string;
      text: string;
    };
    await app.client.chat.update({
      channel: channel_id,
      ts: timestamp,
      text: text,
    });
    return { content: [{ type: "text", text: "Edited" }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// --- Permission Relay ---
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  const state = await loadAccessState(CHANNEL_NAME);
  if (state.allowFrom.length === 0) return;

  const prompt = formatPermissionPrompt(params);
  for (const userId of state.allowFrom) {
    try {
      await app.client.chat.postMessage({
        channel: userId, // DM by user ID
        text: prompt,
      });
    } catch {
      // User may not be reachable
    }
  }
});

// --- Message Handling ---
app.message(async ({ message, say }) => {
  // Ignore bot messages and subtypes (edits, deletes, etc.)
  if (!("user" in message) || !message.user) return;
  if ("subtype" in message && message.subtype) return;
  if (message.user === botUserId) return;

  const senderId = message.user;
  const channelId = message.channel;
  const messageTs = message.ts;
  const threadTs = "thread_ts" in message ? message.thread_ts : undefined;

  // Check for permission verdict
  if ("text" in message && message.text) {
    const verdict = parsePermissionVerdict(message.text);
    if (verdict) {
      await emitPermissionVerdict(mcp, verdict);
      // Acknowledge with check mark
      try {
        await app.client.reactions.add({
          channel: channelId,
          timestamp: messageTs,
          name: "white_check_mark",
        });
      } catch {
        // Ignore reaction failures
      }
      return;
    }
  }

  // Access control
  const access = await checkAccess(CHANNEL_NAME, senderId);
  if (!access.allowed) {
    if (access.reason === "not-paired") {
      await say({
        text: `Welcome! To pair this chat, run this in your Claude Code session:\n\`/claudeclaw-slack:access pair ${access.pairingCode}\``,
        thread_ts: threadTs,
      });
    }
    return;
  }

  // Acknowledge receipt
  try {
    await app.client.reactions.add({
      channel: channelId,
      timestamp: messageTs,
      name: "eyes",
    });
  } catch {
    // Ignore reaction failures
  }

  // Get sender name
  let senderName = senderId;
  try {
    const userInfo = await app.client.users.info({ user: senderId });
    senderName = userInfo.user?.real_name ?? userInfo.user?.name ?? senderId;
  } catch {
    // Fall back to sender ID
  }

  // Track for cron delivery
  lastActiveChat = { channel_id: channelId, sender_id: senderId, sender_name: senderName };

  // Build content
  const parts: string[] = [];
  const meta: Record<string, string> = {
    channel_id: channelId,
    sender_id: senderId,
    sender_name: senderName,
    message_ts: messageTs,
    thread_ts: threadTs ?? messageTs,
  };

  // Text content
  if ("text" in message && message.text) {
    parts.push(message.text);
  }

  // File attachments
  if ("files" in message && Array.isArray(message.files)) {
    for (const file of message.files as any[]) {
      if (file.url_private_download) {
        try {
          const response = await fetch(file.url_private_download, {
            headers: { Authorization: `Bearer ${botToken}` },
          });
          if (response.ok) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            const savedPath = await saveToInbox(CHANNEL_NAME, file.name ?? "file", bytes);
            parts.push(`[File: ${file.name ?? "file"} saved to: ${savedPath}]`);
          } else {
            parts.push(`[File: ${file.name ?? "file"} (download failed)]`);
          }
        } catch {
          parts.push(`[File: ${file.name ?? "file"} (download failed)]`);
        }
      } else {
        parts.push(`[File: ${file.name ?? "file"} (no download URL)]`);
      }
    }
  }

  if (parts.length === 0) {
    parts.push("[Empty or unsupported message]");
  }

  // Emit to Claude
  await mcp.notification({
    method: "notifications/claude/channel" as any,
    params: {
      content: parts.join("\n"),
      meta,
    },
  });

  await logger.logInbound({ chatId: channelId, senderId, senderName, content: parts.join("\n"), meta });
});

// --- Connect and Start ---
await mcp.connect(new StdioServerTransport());

// Start Slack app
await app.start();

// Get bot user ID
try {
  const auth = await app.client.auth.test();
  botUserId = auth.user_id ?? null;
  console.error(`[claudeclaw-slack] connected as ${auth.user ?? "unknown"}`);
} catch (error) {
  console.error("[claudeclaw-slack] failed to get bot identity:", error);
}

// Start cron system
const cron = createChannelCron(mcp, CHANNEL_NAME, {
  resolveTargetChat: () => lastActiveChat,
});
await cron.start();
console.error(`[claudeclaw-slack] cron system started`);

// Graceful shutdown
const shutdown = async () => {
  cron.stop();
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
