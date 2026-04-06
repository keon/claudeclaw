import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveChannelDir } from "./access";

export function resolveInboxDir(channelName: string): string {
  return path.join(resolveChannelDir(channelName), "inbox");
}

export function resolveOutboxDir(channelName: string): string {
  return path.join(resolveChannelDir(channelName), "outbox");
}

export async function saveToInbox(
  channelName: string,
  filename: string,
  data: Uint8Array,
): Promise<string> {
  const dir = resolveInboxDir(channelName);
  await mkdir(dir, { recursive: true });
  const safeName = sanitizeFilename(filename);
  const filePath = path.join(dir, `${Date.now()}-${safeName}`);
  await writeFile(filePath, data);
  return filePath;
}

export async function assertSendable(channelName: string, filePath: string): Promise<void> {
  const channelDir = resolveChannelDir(channelName);
  const resolved = path.resolve(filePath);

  // Block access to channel state files
  if (resolved.startsWith(channelDir) && !resolved.startsWith(resolveOutboxDir(channelName))) {
    throw new Error("Cannot send channel state files");
  }

  const fileStat = await stat(resolved);
  if (fileStat.size > 50 * 1024 * 1024) {
    throw new Error("File exceeds 50MB limit");
  }
}

export async function readSendableFile(filePath: string): Promise<{ data: Buffer; name: string }> {
  const data = await readFile(filePath) as unknown as Buffer;
  return { data, name: path.basename(filePath) };
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[^\w.\-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 200);
}
