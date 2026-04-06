import { spawn, type ChildProcess } from "node:child_process";
import { createClaudeClient } from "./claude-client";

type CliJsonResult = {
  type: string;
  subtype: string;
  is_error: boolean;
  result: string;
  session_id: string;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
};

type CliRuntimeThread = {
  id: string | null;
};

type CliRuntimeOptions = {
  model?: string;
  maxTurns?: number;
  skipPermissions?: boolean;
  systemPrompt?: string;
  allowedTools?: string[];
};

export function createCliRuntimeClient(workingDirectory: string, options: CliRuntimeOptions = {}) {
  return createClaudeClient<CliRuntimeThread>({
    startThread: async () => ({ id: null }),
    resumeThread: async (threadId) => ({ id: threadId }),
    runPrompt: async (thread, prompt, { signal }) => {
      const args = buildClaudeArgs(prompt, thread.id, options);

      const result = await spawnClaude(args, {
        cwd: workingDirectory,
        signal,
      });

      thread.id = result.session_id;

      return {
        summary: result.result,
        touchedPaths: [],
      };
    },
  });
}

function buildClaudeArgs(
  prompt: string,
  sessionId: string | null,
  options: CliRuntimeOptions,
): string[] {
  const args = ["-p", prompt, "--output-format", "json"];

  if (sessionId) {
    args.push("--session-id", sessionId);
  }

  if (options.skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }

  if (options.allowedTools) {
    for (const tool of options.allowedTools) {
      args.push("--allowedTools", tool);
    }
  }

  return args;
}

function spawnClaude(
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
): Promise<CliJsonResult> {
  return new Promise((resolve, reject) => {
    let proc: ChildProcess;

    try {
      proc = spawn("claude", args, {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (error) {
      reject(new Error(`Failed to spawn claude CLI: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    if (options.signal) {
      if (options.signal.aborted) {
        proc.kill("SIGTERM");
        reject(createAbortError());
        return;
      }

      const onAbort = () => {
        proc.kill("SIGTERM");
      };

      options.signal.addEventListener("abort", onAbort, { once: true });

      proc.on("close", () => {
        options.signal!.removeEventListener("abort", onAbort);
      });
    }

    let stdout = "";
    let stderr = "";

    proc.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("error", (error) => {
      reject(new Error(`Claude CLI process error: ${error.message}`));
    });

    proc.on("close", (code) => {
      if (options.signal?.aborted) {
        reject(createAbortError());
        return;
      }

      // Try parsing JSON output regardless of exit code
      // Claude CLI may return non-zero for errors but still produce valid JSON
      const trimmedStdout = stdout.trim();

      if (trimmedStdout.length > 0) {
        try {
          const result = JSON.parse(trimmedStdout) as CliJsonResult;

          if (result.is_error) {
            const error = new Error(result.result || `Claude CLI returned an error`);
            if (result.session_id) {
              Object.assign(error, { threadId: result.session_id });
            }
            reject(error);
            return;
          }

          resolve(result);
          return;
        } catch {
          // JSON parse failed, fall through to error handling
        }
      }

      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() || `Claude CLI exited with code ${code}`,
          ),
        );
        return;
      }

      reject(new Error("Claude CLI produced no output"));
    });
  });
}

function createAbortError(): Error {
  const error = new Error("Run aborted.");
  error.name = "AbortError";
  return error;
}
