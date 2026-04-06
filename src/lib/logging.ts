import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveChannelDir } from "./access";

export type ChannelLogEntry = {
  type: "inbound" | "outbound" | "error";
  channel: string;
  chatId: string;
  senderId?: string;
  senderName?: string;
  content: string;
  meta?: Record<string, string>;
  tool?: string;
  timestamp: string;
  error?: { message: string };
};

function toDateParts(timestamp: string) {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");
  return { year, month, day };
}

export async function writeChannelLog(entry: ChannelLogEntry): Promise<string> {
  const { year, month, day } = toDateParts(entry.timestamp);
  const dir = path.join(resolveChannelDir(entry.channel), "logs", year, month, day);
  const safeTimestamp = entry.timestamp.replaceAll(":", "-");
  const filePath = path.join(dir, `${safeTimestamp}-${randomUUID()}.json`);

  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(entry, null, 2));
  return filePath;
}

export function createChannelLogger(channelName: string) {
  return {
    async logInbound(opts: {
      chatId: string;
      senderId: string;
      senderName: string;
      content: string;
      meta?: Record<string, string>;
    }): Promise<void> {
      try {
        await writeChannelLog({
          type: "inbound",
          channel: channelName,
          chatId: opts.chatId,
          senderId: opts.senderId,
          senderName: opts.senderName,
          content: opts.content,
          meta: opts.meta,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Logging must not break the channel
      }
    },
    async logOutbound(opts: {
      chatId: string;
      content: string;
      tool: string;
    }): Promise<void> {
      try {
        await writeChannelLog({
          type: "outbound",
          channel: channelName,
          chatId: opts.chatId,
          content: opts.content,
          tool: opts.tool,
          timestamp: new Date().toISOString(),
        });
      } catch {}
    },
    async logError(opts: {
      chatId: string;
      error: string;
      tool?: string;
    }): Promise<void> {
      try {
        await writeChannelLog({
          type: "error",
          channel: channelName,
          chatId: opts.chatId,
          content: "",
          tool: opts.tool,
          error: { message: opts.error },
          timestamp: new Date().toISOString(),
        });
      } catch {}
    },
  };
}
