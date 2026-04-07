/**
 * Channel-aware cron integration.
 *
 * Scans ~/.claude-claw/cronjobs/ for JSON job definitions and emits
 * notifications/claude/channel when jobs are due, so Claude handles
 * them like any other inbound message.
 *
 * Supports two scheduling modes:
 * - time-based: "time": "09:00" (runs daily at that time, or on a specific date)
 * - interval-based: "interval": "30s" / "5m" / "1h" (runs every N seconds/minutes/hours)
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// --- Types ---

type TimeSchedule = {
  kind: "time";
  hour: number;
  minute: number;
  date: string | null;
};

type IntervalSchedule = {
  kind: "interval";
  intervalMs: number;
};

type CronJobSpec = {
  id: string;
  sourcePath: string;
  schedule: TimeSchedule | IntervalSchedule;
  disabled: boolean;
  action: { type: "message"; prompt: string };
};

type CronTickResult = {
  executed: string[];
  errors: string[];
};

// --- Paths ---

function cronJobsDir(): string {
  return path.join(os.homedir(), ".claude-claw", "cronjobs");
}

// --- Interval Parsing ---

const INTERVAL_RE = /^(\d+)(s|m|h)$/;

function parseInterval(value: string): number | null {
  const m = INTERVAL_RE.exec(value.trim());
  if (!m) return null;

  const n = Number(m[1]);
  if (n <= 0 || !Number.isFinite(n)) return null;

  switch (m[2]) {
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: return null;
  }
}

// --- Loader ---

async function loadJobSpecs(): Promise<CronJobSpec[]> {
  const dir = cronJobsDir();
  await mkdir(dir, { recursive: true });

  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }

  const specs: CronJobSpec[] = [];

  for (const file of entries) {
    try {
      const raw = JSON.parse(await readFile(path.join(dir, file), "utf8")) as Record<string, unknown>;
      if (raw.disabled === true) continue;

      const id = String(raw.id ?? path.basename(file, ".json"));
      const action = raw.action as { type?: string; prompt?: string } | undefined;
      if (!action || action.type !== "message" || !action.prompt) continue;

      // Try interval-based schedule first
      if (typeof raw.interval === "string") {
        const intervalMs = parseInterval(raw.interval);
        if (intervalMs !== null) {
          specs.push({
            id,
            sourcePath: path.join(dir, file),
            schedule: { kind: "interval", intervalMs },
            disabled: false,
            action: { type: "message", prompt: action.prompt },
          });
          continue;
        }
      }

      // Fall back to time-based schedule
      const time = String(raw.time ?? "");
      const match = /^(\d{2}):(\d{2})$/.exec(time);
      if (!match) continue;

      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) continue;

      specs.push({
        id,
        sourcePath: path.join(dir, file),
        schedule: {
          kind: "time",
          hour,
          minute,
          date: typeof raw.date === "string" ? raw.date : null,
        },
        disabled: false,
        action: { type: "message", prompt: action.prompt },
      });
    } catch {
      // Skip unparseable files
    }
  }

  return specs;
}

// --- Matchers ---

function isTimeDue(schedule: TimeSchedule, now: Date): boolean {
  if (schedule.hour !== now.getHours() || schedule.minute !== now.getMinutes()) {
    return false;
  }

  if (schedule.date === null) return true;

  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return schedule.date === `${y}-${m}-${d}`;
}

async function disableOneShotJob(sourcePath: string): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
    raw.disabled = true;
    const tmp = `${sourcePath}.tmp`;
    await writeFile(tmp, JSON.stringify(raw, null, 2) + "\n");
    await rename(tmp, sourcePath);
  } catch {
    // Best effort
  }
}

// --- Runtime ---

export function createChannelCron(
  mcp: Server,
  channelName: string,
  options: {
    intervalMs?: number;
    resolveTargetChat?: () => Record<string, string> | null;
  } = {},
) {
  const tickIntervalMs = options.intervalMs ?? 10_000; // tick every 10s for interval job precision
  const executedTimeKeys = new Set<string>();
  const intervalLastRun = new Map<string, number>(); // jobId -> lastRunTimestamp
  let timer: ReturnType<typeof setInterval> | null = null;

  function timeKey(id: string, now: Date): string {
    return `${id}:${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  }

  async function emitJob(spec: CronJobSpec): Promise<void> {
    const targetChat = options.resolveTargetChat?.() ?? {};

    await mcp.notification({
      method: "notifications/claude/channel" as any,
      params: {
        content: spec.action.prompt,
        meta: {
          source: "cron",
          job_id: spec.id,
          ...targetChat,
        },
      },
    });
  }

  async function tick(): Promise<CronTickResult> {
    const now = new Date();
    const nowMs = now.getTime();
    const specs = await loadJobSpecs();
    const result: CronTickResult = { executed: [], errors: [] };

    for (const spec of specs) {
      try {
        if (spec.schedule.kind === "time") {
          if (!isTimeDue(spec.schedule, now)) continue;

          const key = timeKey(spec.id, now);
          if (executedTimeKeys.has(key)) continue;
          executedTimeKeys.add(key);

          await emitJob(spec);
          result.executed.push(spec.id);

          // Disable one-shot jobs (those with a date)
          if (spec.schedule.date !== null) {
            await disableOneShotJob(spec.sourcePath);
          }
        } else {
          // Interval-based
          const lastRun = intervalLastRun.get(spec.id) ?? 0;
          if (nowMs - lastRun < spec.schedule.intervalMs) continue;

          intervalLastRun.set(spec.id, nowMs);
          await emitJob(spec);
          result.executed.push(spec.id);
        }
      } catch (error) {
        result.errors.push(`${spec.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return result;
  }

  return {
    async start(): Promise<void> {
      await mkdir(cronJobsDir(), { recursive: true });
      // Run first tick immediately
      try {
        await tick();
      } catch (error) {
        console.error(`[${channelName}:cron] initial tick failed:`, error);
      }
      // Tick frequently for interval precision
      timer = setInterval(() => {
        void tick().catch((error) => {
          console.error(`[${channelName}:cron] tick failed:`, error);
        });
      }, tickIntervalMs);
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
  };
}
