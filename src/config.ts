import { resolveWorkspaceDir } from "./lib/paths";

type Env = Record<string, string | undefined>;

export type AppConfig = {
  telegramBotToken: string | null;
  workspaceDir: string;
  model: string | null;
  maxTurns: number | null;
  skipPermissions: boolean;
  systemPrompt: string | null;
};

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    telegramBotToken: normalizeOptionalEnv(env.TELEGRAM_BOT_TOKEN),
    workspaceDir: resolveWorkspaceDir(env),
    model: normalizeOptionalEnv(env.CLAUDE_CLAW_MODEL),
    maxTurns: parseOptionalInt(env.CLAUDE_CLAW_MAX_TURNS),
    skipPermissions: env.CLAUDE_CLAW_SKIP_PERMISSIONS === "true" || env.CLAUDE_CLAW_SKIP_PERMISSIONS === "1",
    systemPrompt: normalizeOptionalEnv(env.CLAUDE_CLAW_SYSTEM_PROMPT),
  };
}

function normalizeOptionalEnv(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
