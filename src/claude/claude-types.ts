export type ClaudeRunRequest = {
  threadId: string | null;
  prompt: string;
  signal?: AbortSignal;
};

export type ClaudeRunResult = {
  threadId: string;
  summary: string;
  touchedPaths: string[];
};
