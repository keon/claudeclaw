import type { ClaudeRunRequest, ClaudeRunResult } from "./claude-types";

type ClaudeThread = {
  id: string | null;
};

type ClaudePromptResult = {
  summary?: unknown;
  touchedPaths?: unknown;
};

type ClaudeClientDeps<TThread extends ClaudeThread> = {
  startThread: () => Promise<TThread>;
  resumeThread: (threadId: string) => Promise<TThread>;
  runPrompt: (
    thread: TThread,
    prompt: string,
    options: { signal?: AbortSignal },
  ) => Promise<ClaudePromptResult>;
};

function normalizeSummary(summary: unknown): string {
  return typeof summary === "string" ? summary : "";
}

function normalizeTouchedPaths(touchedPaths: unknown): string[] {
  if (!Array.isArray(touchedPaths)) {
    return [];
  }

  return touchedPaths.filter((path): path is string => typeof path === "string");
}

function normalizeThreadId(threadId: unknown): string | null {
  if (typeof threadId !== "string") {
    return null;
  }

  const normalized = threadId.trim();
  return normalized.length > 0 ? normalized : null;
}

export function getThreadIdFromError(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("threadId" in error)) {
    return null;
  }

  return normalizeThreadId((error as { threadId?: unknown }).threadId);
}

function attachThreadId(error: unknown, threadId: unknown): Error {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const recoveredThreadId = getThreadIdFromError(normalizedError) ?? normalizeThreadId(threadId);

  if (recoveredThreadId) {
    Object.assign(normalizedError, { threadId: recoveredThreadId });
  }

  return normalizedError;
}

export function createClaudeClient<TThread extends ClaudeThread>({
  startThread,
  resumeThread,
  runPrompt,
}: ClaudeClientDeps<TThread>) {
  return {
    async runTurn({ threadId, prompt, signal }: ClaudeRunRequest): Promise<ClaudeRunResult> {
      const thread = threadId === null ? await startThread() : await resumeThread(threadId);

      try {
        const result = await runPrompt(thread, prompt, { signal });
        const resolvedThreadId = normalizeThreadId(thread.id);

        if (resolvedThreadId === null) {
          throw new Error("Claude session id was unavailable after the turn completed");
        }

        return {
          threadId: resolvedThreadId,
          summary: normalizeSummary(result.summary),
          touchedPaths: normalizeTouchedPaths(result.touchedPaths),
        };
      } catch (error) {
        throw attachThreadIdAndAbortState(error, {
          threadId: thread.id,
          aborted: signal?.aborted ?? false,
        });
      }
    },
  };
}

function attachThreadIdAndAbortState(
  error: unknown,
  metadata: { threadId: unknown; aborted: boolean },
): Error {
  const normalizedError = attachThreadId(error, metadata.threadId);

  if (!metadata.aborted) {
    return normalizedError;
  }

  normalizedError.name = "AbortError";
  normalizedError.message = "Run aborted.";
  return normalizedError;
}
