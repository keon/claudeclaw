#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Bot, InputFile } from "grammy";
import { checkAccess, loadAccessState } from "../src/lib/access";
import { PermissionRequestSchema, parsePermissionVerdict, emitPermissionVerdict, formatPermissionPrompt } from "../src/lib/permissions";
import { saveToInbox, assertSendable, readSendableFile } from "../src/lib/files";
import { chunkMessage } from "../src/lib/chunker";

const CHANNEL_NAME = "claudeclaw-telegram";
const MAX_TEXT_LENGTH = 4096;

// --- Resolve Telegram bot token ---
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("[claudeclaw-telegram] TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

// --- MCP Server Setup ---
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
      `Messages from Telegram arrive as <channel source="${CHANNEL_NAME}" chat_id="..." sender_id="..." sender_name="...">`,
      "The sender reads the Telegram app, not this terminal session.",
      "",
      "Available tools:",
      `- reply: Send a message back. Pass chat_id from the <channel> tag. Text is auto-chunked at ${MAX_TEXT_LENGTH} chars. Optionally attach files.`,
      "- react: Add an emoji reaction to a message.",
      "- edit_message: Edit a previously sent message.",
      "- download_attachment: Download a file attachment from a message.",
      "",
      "When replying, write naturally. Do not include raw code blocks unless the user asked for code.",
      "Keep replies concise — the user is on a phone.",
    ].join("\n"),
  },
);

// --- Telegram Bot ---
const bot = new Bot(token);

// Track sent messages for edit support
const sentMessages = new Map<string, number[]>(); // chatId -> messageIds

// --- Tools ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply to a Telegram chat",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The chat to reply in (from the channel tag)" },
          text: { type: "string", description: "The message text to send" },
          reply_to: { type: "string", description: "Message ID to reply to (optional)" },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach (optional, max 50MB each)",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "react",
      description: "React to a Telegram message with an emoji",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The chat ID" },
          message_id: { type: "string", description: "The message ID to react to" },
          emoji: { type: "string", description: "The emoji to react with (e.g. 👍)" },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "edit_message",
      description: "Edit a previously sent message",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string", description: "The chat ID" },
          message_id: { type: "string", description: "The message ID to edit" },
          text: { type: "string", description: "The new text" },
        },
        required: ["chat_id", "message_id", "text"],
      },
    },
    {
      name: "download_attachment",
      description: "Download a file attachment from Telegram and save it locally",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: { type: "string", description: "The Telegram file_id" },
          filename: { type: "string", description: "Desired filename" },
        },
        required: ["file_id"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "reply") {
    const { chat_id, text, reply_to, files } = args as {
      chat_id: string;
      text: string;
      reply_to?: string;
      files?: string[];
    };

    const chatId = Number(chat_id);
    const chunks = chunkMessage(text, { maxLength: MAX_TEXT_LENGTH });
    const messageIds: number[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const sent = await bot.api.sendMessage(chatId, chunks[i], {
        // Only apply reply_to on the first chunk
        reply_to_message_id: i === 0 && reply_to ? Number(reply_to) : undefined,
      });
      messageIds.push(sent.message_id);
    }

    // Send files if any
    if (files && files.length > 0) {
      for (const filePath of files) {
        try {
          await assertSendable(CHANNEL_NAME, filePath);
          const { data, name: fileName } = await readSendableFile(filePath);
          const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(fileName);

          if (isImage) {
            const sent = await bot.api.sendPhoto(chatId, new InputFile(data, fileName));
            messageIds.push(sent.message_id);
          } else {
            const sent = await bot.api.sendDocument(chatId, new InputFile(data, fileName));
            messageIds.push(sent.message_id);
          }
        } catch (error) {
          await bot.api.sendMessage(
            chatId,
            `Failed to send file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    sentMessages.set(chat_id, [...(sentMessages.get(chat_id) ?? []), ...messageIds]);
    return { content: [{ type: "text", text: `Sent ${chunks.length} message(s), IDs: ${messageIds.join(", ")}` }] };
  }

  if (name === "react") {
    const { chat_id, message_id, emoji } = args as { chat_id: string; message_id: string; emoji: string };
    await bot.api.setMessageReaction(Number(chat_id), Number(message_id), [{ type: "emoji", emoji: emoji as any }]);
    return { content: [{ type: "text", text: "Reacted" }] };
  }

  if (name === "edit_message") {
    const { chat_id, message_id, text } = args as { chat_id: string; message_id: string; text: string };
    await bot.api.editMessageText(Number(chat_id), Number(message_id), text);
    return { content: [{ type: "text", text: "Edited" }] };
  }

  if (name === "download_attachment") {
    const { file_id, filename } = args as { file_id: string; filename?: string };
    const file = await bot.api.getFile(file_id);
    if (!file.file_path) throw new Error("File path unavailable");

    const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const name = filename ?? file.file_path.split("/").pop() ?? "file";
    const savedPath = await saveToInbox(CHANNEL_NAME, name, bytes);
    return { content: [{ type: "text", text: `Saved to ${savedPath}` }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// --- Permission Relay ---
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // Forward permission request to the most recent chat
  const state = await loadAccessState(CHANNEL_NAME);
  if (state.allowFrom.length === 0) return;

  const prompt = formatPermissionPrompt(params);
  // Send to all allowed users
  for (const userId of state.allowFrom) {
    try {
      await bot.api.sendMessage(Number(userId), prompt);
    } catch {
      // User may have blocked the bot
    }
  }
});

// --- Message Handling ---
bot.on("message", async (ctx) => {
  const senderId = String(ctx.from?.id ?? "");
  const senderName =
    [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") ||
    ctx.from?.username ||
    "Unknown";
  const chatId = String(ctx.chat.id);

  // Check for permission verdict
  if (ctx.message.text) {
    const verdict = parsePermissionVerdict(ctx.message.text);
    if (verdict) {
      await emitPermissionVerdict(mcp, verdict);
      await ctx.react("👍");
      return;
    }
  }

  // Access control
  const access = await checkAccess(CHANNEL_NAME, senderId, senderName);
  if (!access.allowed) {
    if (access.reason === "not-paired") {
      await ctx.reply(
        `Welcome! To pair this chat, run this in your Claude Code session:\n\n` +
          `/claudeclaw-telegram:access pair ${access.pairingCode}`,
      );
    }
    return;
  }

  // Acknowledge receipt
  await ctx.react("👀").catch(() => {});

  // Build notification content
  const parts: string[] = [];
  const meta: Record<string, string> = {
    chat_id: chatId,
    sender_id: senderId,
    sender_name: senderName,
  };

  if (ctx.message.reply_to_message) {
    meta.reply_to_message_id = String(ctx.message.reply_to_message.message_id);
  }

  // Text
  if (ctx.message.text) {
    parts.push(ctx.message.text);
  }

  // Caption
  if (ctx.message.caption) {
    parts.push(ctx.message.caption);
  }

  // Photo — auto-download the largest size
  if (ctx.message.photo && ctx.message.photo.length > 0) {
    const largest = ctx.message.photo.reduce((a, b) =>
      a.width * a.height > b.width * b.height ? a : b,
    );
    try {
      const file = await bot.api.getFile(largest.file_id);
      if (file.file_path) {
        const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
        if (response.ok) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          const name = file.file_path.split("/").pop() ?? "photo.jpg";
          const savedPath = await saveToInbox(CHANNEL_NAME, name, bytes);
          parts.push(`[Photo saved to: ${savedPath}]`);
        }
      }
    } catch {
      parts.push(
        `[Photo attached, file_id: ${largest.file_id} — use download_attachment to retrieve]`,
      );
    }
  }

  // Document
  if (ctx.message.document) {
    const doc = ctx.message.document;
    parts.push(
      `[Document: ${doc.file_name ?? "file"} (${doc.mime_type ?? "unknown"}), file_id: ${doc.file_id} — use download_attachment to retrieve]`,
    );
  }

  // Voice / Audio / Video / Sticker
  if (ctx.message.voice) {
    parts.push(`[Voice message, file_id: ${ctx.message.voice.file_id} — use download_attachment to retrieve]`);
  }
  if (ctx.message.audio) {
    parts.push(`[Audio: ${ctx.message.audio.title ?? "audio"}, file_id: ${ctx.message.audio.file_id}]`);
  }
  if (ctx.message.video) {
    parts.push(`[Video, file_id: ${ctx.message.video.file_id}]`);
  }
  if (ctx.message.sticker) {
    parts.push(`[Sticker: ${ctx.message.sticker.emoji ?? ""}]`);
  }

  if (parts.length === 0) {
    parts.push("[Empty or unsupported message type]");
  }

  meta.message_id = String(ctx.message.message_id);

  // Emit to Claude
  await mcp.notification({
    method: "notifications/claude/channel" as any,
    params: {
      content: parts.join("\n"),
      meta,
    },
  });
});

// --- Connect and Start ---
await mcp.connect(new StdioServerTransport());

// Start Telegram polling (don't await — runs until bot.stop() is called)
void bot.start({
  onStart: () => {
    console.error(`[claudeclaw-telegram] polling as @${bot.botInfo?.username ?? "unknown"}`);
  },
});

// Graceful shutdown
const shutdown = () => {
  bot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
