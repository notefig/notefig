import type { PromptContextPart } from "@notefig/shared/agent";
import { file } from "@/entities/files";
import { extractMentionPaths } from "@/utils/prompt-mentions";

/** file:// URI for an absolute path, per-segment percent-encoded. */
export function pathToFileUri(absolutePath: string): string {
  return "file://" + absolutePath.split("/").map(encodeURIComponent).join("/");
}

/**
 * Turn a finished prompt's @-mentions into resource_link context parts
 * (MET-80). Tokens are resolved against the workspace's metadata collection
 * at send time — only tokens naming a real file become parts; everything
 * else stays plain text. URIs are file:// (not notefig://widget-context):
 * the MCP server's resources/read only decodes widget-context URIs, so
 * mention links must be readable by the harness's own file tools.
 */
export function mentionContextParts(
  workspacePath: string,
  text: string,
): PromptContextPart[] {
  // workspacePath must stay byte-identical to the collection's workspaceId
  // (rows are keyed `<workspaceId>/<relativePath>`) — no normalization.
  const root = workspacePath.replace(/\/+$/, "");
  const toAbsolute = (token: string) => `${root}/${token.replace(/^\/+/, "")}`;
  const isFile = (token: string) => {
    const handle = file(workspacePath, toAbsolute(token));
    return handle.exists() && handle.metadata()?.type === "file";
  };
  return extractMentionPaths(text, isFile).map((token) => ({
    kind: "resource_link" as const,
    path: pathToFileUri(toAbsolute(token)),
    name: token,
  }));
}
