/**
 * Channel-aware cron integration.
 *
 * Scans ~/.claude-claw/cronjobs/ for JSON job definitions and emits
 * notifications/claude/channel when jobs are due, so Claude handles
 * them like any other inbound message.
 */
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

// --- Types ---

type CronJobSpec = {
  id: string;
  sourcePath: string;
  time: string;
  hour: number;
  minute: number;
  date: string | null;
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
      const time = String(raw.time ?? "");
      const match = /^(\d{2}):(\d{2})$/.exec(time);
      if (!match) continue;

      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) continue;

      const action = raw.action as { type?: string; prompt?: string } | undefined;
      if (!action || action.type !== "message" || !action.prompt) continue;

      specs.push({
        id,
        sourcePath: path.join(dir, file),
        time,
        hour,
        minute,
        date: typeof raw.date === "string" ? raw.date : null,
        disabled: false,
        action: { type: "message", prompt: action.prompt },
      });
    } catch {
      // Skip unparseable files
    }
  }

  return specs;
}

// --- Matcher ---

function isDue(spec: CronJobSpec, now: Date): boolean {
  if (spec.hour !== now.getHours() || spec.minute !== now.getMinutes()) {
    return false;
  }

  if (spec.date === null) return true;

  const y = String(now.getFullYear()).padStart(4, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return spec.date === `${y}-${m}-${d}`;
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
  options: { intervalMs?: number } = {},
) {
  const intervalMs = options.intervalMs ?? 60_000;
  const executedKeys = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function minuteKey(spec: CronJobSpec, now: Date): string {
    return `${spec.id}:${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  }

  async function tick(): Promise<CronTickResult> {
    const now = new Date();
    const specs = await loadJobSpecs();
    const result: CronTickResult = { executed: [], errors: [] };

    for (const spec of specs) {
      if (!isDue(spec, now)) continue;

      const key = minuteKey(spec, now);
      if (executedKeys.has(key)) continue;
      executedKeys.add(key);

      try {
        // Emit the cron prompt as a channel notification
        await mcp.notification({
          method: "notifications/claude/channel" as any,
          params: {
            content: spec.action.prompt,
            meta: {
              source: "cron",
              job_id: spec.id,
              scheduled_time: spec.time,
            },
          },
        });

        result.executed.push(spec.id);

        // Disable one-shot jobs (those with a date)
        if (spec.date !== null) {
          await disableOneShotJob(spec.sourcePath);
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
      // Then every minute
      timer = setInterval(() => {
        void tick().catch((error) => {
          console.error(`[${channelName}:cron] tick failed:`, error);
        });
      }, intervalMs);
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
