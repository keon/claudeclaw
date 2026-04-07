/**
 * Heartbeat system — periodic agent check-ins.
 *
 * Reads ~/.claude-claw/HEARTBEAT.md for a checklist of things to monitor.
 * Emits a channel notification at a configurable interval so Claude can
 * review and surface anything that needs attention.
 *
 * Protocol:
 * - If nothing needs attention, Claude replies with "HEARTBEAT_OK"
 * - HEARTBEAT_OK replies are suppressed (not delivered to the user)
 * - Actual alerts are delivered normally
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// --- Config ---

export type HeartbeatConfig = {
  /** Interval between heartbeats (e.g. "30m", "1h", "5m"). Default: "30m" */
  every?: string;
  /** Where to deliver: "last" (last active chat) or "none" (run but don't deliver). Default: "last" */
  target?: "last" | "none";
  /** Custom prompt. Default reads HEARTBEAT.md */
  prompt?: string;
  /** Active hours window. Omit for 24/7. */
  activeHours?: { start: string; end: string };
  /** Max chars after HEARTBEAT_OK before it counts as an alert. Default: 50 */
  ackMaxChars?: number;
};

// --- Paths ---

function heartbeatFilePath(): string {
  return path.join(os.homedir(), ".claude-claw", "HEARTBEAT.md");
}

// --- Interval Parsing ---

function parseIntervalMs(value: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(value.trim());
  if (!m) return 30 * 60_000; // default 30m

  const n = Number(m[1]);
  switch (m[2]) {
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: return 30 * 60_000;
  }
}

// --- Active Hours ---

function isWithinActiveHours(config: HeartbeatConfig): boolean {
  if (!config.activeHours) return true;

  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const [startH, startM] = config.activeHours.start.split(":").map(Number);
  const [endH, endM] = config.activeHours.end.split(":").map(Number);

  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes === endMinutes) return false; // zero-width = always skip

  if (endMinutes > startMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Wraps midnight
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

// --- HEARTBEAT.md Reader ---

async function readHeartbeatFile(): Promise<string | null> {
  try {
    const content = await readFile(heartbeatFilePath(), "utf8");
    // If effectively empty (only whitespace, comments, headers), skip
    const stripped = content.replace(/^#.*$/gm, "").replace(/^[\s-]*$/gm, "").trim();
    if (stripped.length === 0) return null;
    return content;
  } catch {
    return null; // File doesn't exist — heartbeat still runs
  }
}

// --- HEARTBEAT_OK Detection ---

const HEARTBEAT_OK = "HEARTBEAT_OK";

export function isHeartbeatOk(text: string, ackMaxChars: number = 50): boolean {
  const trimmed = text.trim();

  // Exact match
  if (trimmed === HEARTBEAT_OK) return true;

  // Starts or ends with HEARTBEAT_OK, remaining content is small
  if (trimmed.startsWith(HEARTBEAT_OK)) {
    const rest = trimmed.slice(HEARTBEAT_OK.length).trim();
    return rest.length <= ackMaxChars;
  }
  if (trimmed.endsWith(HEARTBEAT_OK)) {
    const rest = trimmed.slice(0, -HEARTBEAT_OK.length).trim();
    return rest.length <= ackMaxChars;
  }

  return false;
}

export function stripHeartbeatOk(text: string): string {
  return text
    .replace(new RegExp(`^\\s*${HEARTBEAT_OK}\\s*`, ""), "")
    .replace(new RegExp(`\\s*${HEARTBEAT_OK}\\s*$`, ""), "")
    .trim();
}

// --- Default Prompt ---

const DEFAULT_PROMPT = [
  "Read ~/.claude-claw/HEARTBEAT.md if it exists.",
  "Follow the checklist strictly. Do not infer or repeat old tasks from prior chats.",
  "If nothing needs attention, reply with exactly: HEARTBEAT_OK",
  "If something needs attention, reply with a concise alert — do NOT include HEARTBEAT_OK.",
].join(" ");

// --- Runtime ---

export function createHeartbeat(
  mcp: Server,
  channelName: string,
  config: HeartbeatConfig = {},
  resolveTargetChat?: () => Record<string, string> | null,
) {
  const intervalMs = parseIntervalMs(config.every ?? "30m");
  const ackMaxChars = config.ackMaxChars ?? 50;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function beat(): Promise<"ok" | "skipped" | "emitted"> {
    // Check active hours
    if (!isWithinActiveHours(config)) {
      return "skipped";
    }

    // Build prompt
    let prompt = config.prompt ?? DEFAULT_PROMPT;
    const heartbeatContent = await readHeartbeatFile();
    if (heartbeatContent !== null) {
      prompt += `\n\nHEARTBEAT.md contents:\n${heartbeatContent}`;
    }

    // Resolve target
    const target = config.target ?? "last";
    const meta: Record<string, string> = {
      source: "heartbeat",
    };

    if (target === "last" && resolveTargetChat) {
      const chat = resolveTargetChat();
      if (chat) Object.assign(meta, chat);
    }

    // Emit
    await mcp.notification({
      method: "notifications/claude/channel" as any,
      params: { content: prompt, meta },
    });

    return "emitted";
  }

  return {
    async start(): Promise<void> {
      // Ensure HEARTBEAT.md directory exists
      await mkdir(path.dirname(heartbeatFilePath()), { recursive: true });

      // First beat after a short delay (let the session stabilize)
      setTimeout(() => {
        void beat().catch((e) => console.error(`[${channelName}:heartbeat] beat failed:`, e));
      }, 5_000);

      // Then at interval
      timer = setInterval(() => {
        void beat().catch((e) => console.error(`[${channelName}:heartbeat] beat failed:`, e));
      }, intervalMs);

      console.error(`[${channelName}:heartbeat] started (every ${config.every ?? "30m"})`);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    beat,
    /** Check if a reply text is a HEARTBEAT_OK acknowledgment that should be suppressed */
    shouldSuppress: (text: string) => isHeartbeatOk(text, ackMaxChars),
    /** Strip HEARTBEAT_OK from reply text */
    stripOk: stripHeartbeatOk,
  };
}
