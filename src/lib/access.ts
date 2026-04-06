import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AccessPolicy } from "./types";

export type AccessState = {
  dmPolicy: AccessPolicy;
  allowFrom: string[];
  pairings: Record<string, { code: string; platformUsername?: string; createdAt: number; reminders: number }>;
};

const DEFAULT_STATE: AccessState = {
  dmPolicy: "pairing",
  allowFrom: [],
  pairings: {},
};

export function resolveChannelDir(channelName: string): string {
  return path.join(os.homedir(), ".claude", "channels", channelName);
}

export function resolveAccessPath(channelName: string): string {
  return path.join(resolveChannelDir(channelName), "access.json");
}

export async function loadAccessState(channelName: string): Promise<AccessState> {
  try {
    const raw = await readFile(resolveAccessPath(channelName), "utf8");
    const parsed = JSON.parse(raw) as Partial<AccessState>;
    return {
      dmPolicy: parsed.dmPolicy ?? DEFAULT_STATE.dmPolicy,
      allowFrom: Array.isArray(parsed.allowFrom) ? parsed.allowFrom : [],
      pairings: parsed.pairings && typeof parsed.pairings === "object" ? parsed.pairings : {},
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveAccessState(channelName: string, state: AccessState): Promise<void> {
  const dir = resolveChannelDir(channelName);
  await mkdir(dir, { recursive: true });
  await writeFile(resolveAccessPath(channelName), JSON.stringify(state, null, 2));
}

export function generatePairingCode(): string {
  return randomBytes(3).toString("hex");
}

export type AccessCheckResult =
  | { allowed: true }
  | { allowed: false; reason: "disabled" }
  | { allowed: false; reason: "not-paired"; pairingCode: string };

export async function checkAccess(
  channelName: string,
  senderId: string,
  senderName?: string,
): Promise<AccessCheckResult> {
  const state = await loadAccessState(channelName);

  if (state.dmPolicy === "disabled") {
    return { allowed: false, reason: "disabled" };
  }

  if (state.allowFrom.includes(senderId)) {
    return { allowed: true };
  }

  if (state.dmPolicy === "allowlist") {
    return { allowed: false, reason: "disabled" };
  }

  // Pairing mode: generate or return existing code
  const existing = state.pairings[senderId];
  if (existing) {
    existing.reminders++;
    await saveAccessState(channelName, state);
    return { allowed: false, reason: "not-paired", pairingCode: existing.code };
  }

  const code = generatePairingCode();
  state.pairings[senderId] = {
    code,
    platformUsername: senderName,
    createdAt: Date.now(),
    reminders: 0,
  };
  await saveAccessState(channelName, state);
  return { allowed: false, reason: "not-paired", pairingCode: code };
}

export async function completePairing(channelName: string, code: string): Promise<{ paired: boolean; userId?: string }> {
  const state = await loadAccessState(channelName);
  for (const [userId, pairing] of Object.entries(state.pairings)) {
    if (pairing.code === code) {
      state.allowFrom.push(userId);
      delete state.pairings[userId];
      await saveAccessState(channelName, state);
      return { paired: true, userId };
    }
  }
  return { paired: false };
}
