import os from "node:os";
import path from "node:path";

export function resolveWorkspaceDir(env: Record<string, string | undefined>) {
  const workspaceDir = env.CLAUDE_CLAW_WORKSPACE_DIR?.trim();

  if (workspaceDir) {
    return path.resolve(workspaceDir);
  }

  return path.join(resolveClaudeClawHomeDir(), "workspace");
}

export function resolveClaudeClawHomeDir() {
  return path.join(os.homedir(), ".claude-claw");
}
