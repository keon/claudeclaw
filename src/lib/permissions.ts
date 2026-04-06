import { z } from "zod";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

export type PermissionRequest = z.infer<typeof PermissionRequestSchema>["params"];

export type PermissionVerdict = {
  requestId: string;
  behavior: "allow" | "deny";
};

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

export function parsePermissionVerdict(text: string): PermissionVerdict | null {
  const m = PERMISSION_REPLY_RE.exec(text);
  if (!m) return null;
  return {
    requestId: m[2].toLowerCase(),
    behavior: m[1].toLowerCase().startsWith("y") ? "allow" : "deny",
  };
}

export async function emitPermissionVerdict(
  mcp: Server,
  verdict: PermissionVerdict,
): Promise<void> {
  await mcp.notification({
    method: "notifications/claude/channel/permission" as any,
    params: {
      request_id: verdict.requestId,
      behavior: verdict.behavior,
    },
  });
}

export function formatPermissionPrompt(req: PermissionRequest): string {
  return (
    `🔐 Claude wants to run ${req.tool_name}: ${req.description}\n\n` +
    `Reply "yes ${req.request_id}" or "no ${req.request_id}"`
  );
}
