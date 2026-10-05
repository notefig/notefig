/**
 * Which prompt round wrote the content an editor is adopting — the app's
 * half of prompt change tracking. The widget package records and shows a
 * round's changes; all it needs from the app is a tag on the adoption
 * transaction naming the round (PROMPT_CHANGE_META), and this module is the
 * one place that decides it.
 *
 * Agent writes reach an open editor two ways, and neither says who wrote:
 * an ACP `fs/write_text_file` (adopted inside the write, while the tool
 * call is still running) or a harness writing to disk itself — Claude Code
 * does — adopted when the watcher catches up, usually after the tool call
 * has already reported done. So attribution is kept as two current-state
 * facts per document, fed by the agent service's `agent:tool-call` hook:
 *
 * - IN FLIGHT: a mutating tool call on the path that has not settled yet.
 *   It stays in flight until its settle has read the file back, so an
 *   adoption racing that read is still covered.
 * - WRITTEN: when a mutating tool call settles, the file's bytes are read
 *   and their hash recorded as that round's. Adopting exactly those bytes
 *   later is adopting that round's write, whenever the watcher delivers it.
 *
 * A turn that settles with tool calls still open (cancel, error) finishes
 * them the same way. Nothing here is persisted: a restart forgets every
 * round, the same as the widget's own state.
 */
import type { ToolCallUpdate } from "@notefig/shared/agent";
import {
  findPromptBlobForTask,
  isMutatingToolCall,
  type PromptChangeAttribution,
} from "@notefig/widgets";
import { platformAdapter } from "@/adapters";
import { onAppEvent, type AppEvents } from "@/utils/app-events";
import { calculateContentHash } from "@/utils/hash";
import { resolveWorkspacePath } from "@/utils/fs";
import { defineModule } from "@notefig/core";

type Writer = { taskId: string; turnId: string };
type InFlightCall = Writer & { key: string; paths: string[] };

const SETTLED = new Set(["completed", "failed"]);

/** path → the unsettled mutating calls on it, keyed task:toolCallId. */
const inFlight = new Map<string, Map<string, InFlightCall>>();
/** path → the round whose write the file held when its call settled. */
const written = new Map<string, Writer & { contentHash: string }>();

/** Absolute paths the call names — adoption looks files up by absolute
 *  path, and a diff item may carry a workspace-relative one. */
function toolCallPaths(
  toolCall: ToolCallUpdate,
  workspacePath: string,
): string[] {
  const named = [
    ...(toolCall.locations ?? []).map((location) => location.path),
    ...(toolCall.content ?? []).flatMap((item) =>
      item.type === "diff" ? [item.path] : [],
    ),
  ];
  const paths = named.map((path) => {
    const resolved = resolveWorkspacePath(workspacePath, path);
    return resolved.ok ? resolved.absolute : path;
  });
  return [...new Set(paths)];
}

async function readHash(path: string): Promise<string | null> {
  const result = await platformAdapter.fs.readFiles([path]);
  const file = result.succeeded[0];
  return file ? calculateContentHash(file.content) : null;
}

/** Record what the call left on disk, then let it leave flight. */
async function settleCall(call: InFlightCall): Promise<void> {
  try {
    await Promise.all(
      call.paths.map(async (path) => {
        const contentHash = await readHash(path).catch(() => null);
        if (contentHash) {
          written.set(path, {
            taskId: call.taskId,
            turnId: call.turnId,
            contentHash,
          });
        }
      }),
    );
  } finally {
    for (const path of call.paths) {
      const calls = inFlight.get(path);
      calls?.delete(call.key);
      if (calls?.size === 0) inFlight.delete(path);
    }
  }
}

/** The `agent:tool-call` listener. Exported for tests; resolves once a
 *  settling call's read-back is recorded. */
export async function recordToolCall(
  detail: AppEvents["agent:tool-call"],
): Promise<void> {
  const { toolCall, taskId, turnId, workspacePath } = detail;
  if (!isMutatingToolCall(toolCall)) return;
  const paths = toolCallPaths(toolCall, workspacePath);
  if (paths.length === 0) return;
  const call: InFlightCall = {
    taskId,
    turnId,
    key: `${taskId}:${toolCall.toolCallId}`,
    paths,
  };
  for (const path of paths) {
    // A new write on the path supersedes whatever the last one left: bytes
    // matching an earlier round's hash from here on are this call's doing.
    written.delete(path);
    let calls = inFlight.get(path);
    if (!calls) inFlight.set(path, (calls = new Map()));
    calls.set(call.key, call);
  }
  if (toolCall.status && SETTLED.has(toolCall.status)) await settleCall(call);
}

/** The `agent:turn-settled` listener: close whatever the turn left open. */
export async function recordTurnSettled(
  detail: Pick<AppEvents["agent:turn-settled"], "turnId">,
): Promise<void> {
  const open = new Map<string, InFlightCall>();
  for (const calls of inFlight.values()) {
    for (const call of calls.values()) {
      if (call.turnId === detail.turnId) open.set(call.key, call);
    }
  }
  await Promise.all([...open.values()].map(settleCall));
}

/**
 * The exact bytes a settled call left win; failing that, a call still
 * mid-write on the path is the author. The in-flight answer cannot tell a
 * round's write from another process writing the same file in the same
 * moment — nothing observable can — so it is only the fallback. Several
 * rounds mid-write on one file: the latest call is the likelier author.
 */
function writerOf(path: string, contentHash: string): Writer | null {
  const settled = written.get(path);
  if (settled?.contentHash === contentHash) return settled;
  const calls = [...(inFlight.get(path)?.values() ?? [])];
  return calls[calls.length - 1] ?? null;
}

/**
 * The round to credit with adopting `contentHash` into the editor for
 * `path` — null when no round wrote it, or the round that did is no longer
 * the one its widget is watching (a chat turn, or a widget that has moved
 * on to a new turn). Reads current state only; never consumes it.
 */
export function attributeAdoption(
  path: string,
  contentHash: string,
): PromptChangeAttribution | null {
  const writer = writerOf(path, contentHash);
  if (!writer) return null;
  const widget = findPromptBlobForTask(writer.taskId, writer.turnId);
  return widget ? { blobId: widget.blobId, turnId: writer.turnId } : null;
}

/** Test-only: forget every round. */
export function resetTurnWritesForTest(): void {
  inFlight.clear();
  written.clear();
}

/** Boot: the one listener pair. Returns the unsubscribe. */
export function startTurnWriteTracking(): () => void {
  const report = (error: unknown) =>
    console.error("Failed to attribute an agent write:", error);
  const stops = [
    onAppEvent("agent:tool-call", (detail) => {
      void recordToolCall(detail).catch(report);
    }),
    onAppEvent("agent:turn-settled", (detail) => {
      void recordTurnSettled(detail).catch(report);
    }),
  ];
  return () => stops.forEach((stop) => stop());
}

/** Attributes agent writes to the turn that made them. */
export const turnWritesModule = defineModule({
  name: "turn-writes",
  boot: () => startTurnWriteTracking(),
});
