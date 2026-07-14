import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArrowUp, FileText, Quote, X } from "lucide-react";
import type {
  HarnessDefinition,
  PromptContextPart,
} from "@metrists/shared/agent";
import { BUILT_IN_HARNESSES } from "@metrists/shared/agent";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useKv } from "@/utils/kv-store";
import { normalizePath, getFileName } from "@/utils/fs";
import { getOrCreateWorkspaceCollections } from "@/utils/collections";
import {
  getWorkspaceEditorContext,
  getSelectedText,
} from "@/components/editor/editor-store";
import { promptAgentTask, startAgentTask } from "@/agent/agent-service";
import { describeTaskMeta, useAgentTaskList } from "@/hooks/use-agent-tasks";
import { StatusDot } from "./session-switcher";

/**
 * The floating prompt (Stage 4): a summonable (⌘I) surface for starting and
 * steering agent tasks — distinct from the panel, which is where tasks are
 * *watched*. Context-aware by default: seeded from the editor-context
 * snapshot (active document as implicit subject, open files as removable
 * chips, selection as a quoted part), with @-mentions resolving workspace
 * documents. Referenced context is always explicit and visible as chips —
 * never silently attached. It is a prompt composer, not a command palette.
 */

type ContextChip =
  | { kind: "file"; path: string }
  | { kind: "selection"; path: string; text: string };

/** "new" → start a fresh task on the chosen harness; else an existing taskId. */
type Target = { type: "new"; harness: HarnessDefinition } | { type: "task"; taskId: string };

export function FloatingPrompt({
  workspacePath,
  open,
  onOpenChange,
}: {
  workspacePath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const normalized = normalizePath(workspacePath);
  const [text, setText] = useState("");
  const [chips, setChips] = useState<ContextChip[]>([]);
  const [target, setTarget] = useState<Target>({
    type: "new",
    harness: BUILT_IN_HARNESSES[0],
  });
  const [confirmTrust, setConfirmTrust] = useState(false);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const kv = useKv<boolean>("agent");
  const trustKey = `trust:${normalized}`;

  // Shared ordering/status derivation with the panel's session switcher —
  // last-activity order, queued counts, meta labels — filtered here to the
  // tasks worth steering (idle/running).
  const taskMetas = useAgentTaskList(normalized);
  const liveTasks = useMemo(
    () =>
      taskMetas.filter(
        (meta) => meta.task.status === "idle" || meta.task.status === "running",
      ),
    [taskMetas],
  );

  // Seed context chips from the editor snapshot each time the box opens.
  useEffect(() => {
    if (!open) return;
    const context = getWorkspaceEditorContext(workspacePath);
    const seeded: ContextChip[] = [];
    if (context.activeFile) {
      const selection = getSelectedText(context.activeFile);
      if (selection) {
        seeded.push({ kind: "selection", path: context.activeFile, text: selection });
      }
    }
    for (const file of context.openFiles) {
      seeded.push({ kind: "file", path: file.path });
    }
    setChips(seeded);
    setConfirmTrust(false);
    // Focus after the overlay mounts.
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [open, workspacePath]);

  // ===== @-mentions over the workspace document tree =====

  const mentionQuery = useMemo(() => {
    const match = /@([\w./-]*)$/.exec(text);
    return match ? match[1].toLowerCase() : null;
  }, [text]);

  const { metadata } = getOrCreateWorkspaceCollections(workspacePath);
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const chipPaths = new Set(chips.filter((c) => c.kind === "file").map((c) => c.path));
    return metadata.toArray
      .filter(
        (entry) =>
          entry.type === "file" &&
          !chipPaths.has(entry.path) &&
          (entry.relativePath ?? entry.path).toLowerCase().includes(mentionQuery),
      )
      .slice(0, 8);
  }, [mentionQuery, metadata, chips]);

  const applyMention = useCallback(
    (path: string) => {
      setChips((current) => [...current, { kind: "file", path }]);
      setText((current) => current.replace(/@[\w./-]*$/, ""));
      textareaRef.current?.focus();
    },
    [],
  );

  // ===== send =====

  const doSend = useCallback(async () => {
    const prompt = text.trim();
    if (!prompt || sending) return;

    const contextParts: PromptContextPart[] = chips
      .filter((chip): chip is Extract<ContextChip, { kind: "file" }> => chip.kind === "file")
      .map((chip) => ({ kind: "resource_link", path: chip.path }));
    const selection = chips.find(
      (chip): chip is Extract<ContextChip, { kind: "selection" }> =>
        chip.kind === "selection",
    );
    const fullText = selection
      ? `Regarding this selection from ${getFileName(selection.path)}:\n\n> ${selection.text.split("\n").join("\n> ")}\n\n${prompt}`
      : prompt;

    setSending(true);
    try {
      if (target.type === "task") {
        promptAgentTask(target.taskId, fullText, contextParts);
      } else {
        const taskId = await startAgentTask(workspacePath, target.harness);
        promptAgentTask(taskId, fullText, contextParts);
      }
      setText("");
      onOpenChange(false);
    } catch (error) {
      console.error("Floating prompt send failed:", error);
    } finally {
      setSending(false);
    }
  }, [text, sending, chips, target, workspacePath, onOpenChange]);

  const handleSend = useCallback(() => {
    // New tasks in an untrusted workspace confirm inline first (same trust
    // gate as the panel, same KV flag).
    if (target.type === "new" && !kv.get(trustKey) && !confirmTrust) {
      setConfirmTrust(true);
      return;
    }
    if (confirmTrust) kv.set(trustKey, true);
    void doSend();
  }, [target, kv, trustKey, confirmTrust, doSend]);

  if (!open) return null;

  const targetLabel =
    target.type === "new"
      ? `New task · ${target.harness.label}`
      : (liveTasks.find((meta) => meta.task.taskId === target.taskId)?.task
          .title ?? "Task");

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center bg-black/20 pt-[18vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div className="w-[min(640px,90vw)] rounded-2xl border border-border bg-card shadow-2xl">
        {/* Context chips — always visible before send, each removable. */}
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {chips.map((chip, index) => (
              <span
                key={`${chip.kind}:${chip.path}:${index}`}
                className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {chip.kind === "selection" ? (
                  <Quote className="size-3" />
                ) : (
                  <FileText className="size-3" />
                )}
                {getFileName(chip.path)}
                {chip.kind === "selection" && " (selection)"}
                <button
                  type="button"
                  aria-label="Remove context"
                  className="rounded-full p-0.5 hover:bg-background"
                  onClick={() =>
                    setChips((current) => current.filter((_, i) => i !== index))
                  }
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onOpenChange(false);
            }
            if (event.key === "Enter" && !event.shiftKey && mentionCandidates.length > 0) {
              event.preventDefault();
              applyMention(mentionCandidates[0].path);
              return;
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask about your documents… @ to reference a file"
          rows={3}
          className="max-h-48 min-h-[56px] w-full resize-none bg-transparent px-4 pt-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
        />

        {/* @-mention suggestions */}
        {mentionCandidates.length > 0 && (
          <div className="mx-3 mb-1 overflow-hidden rounded-md border border-border">
            {mentionCandidates.map((entry, index) => (
              <button
                key={entry.path}
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 px-2 py-1 text-left text-xs hover:bg-muted",
                  index === 0 && "bg-muted/60",
                )}
                onClick={() => applyMention(entry.path)}
              >
                <FileText className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.relativePath ?? entry.path}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 px-3 pb-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="max-w-56 truncate text-xs">
                {targetLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {BUILT_IN_HARNESSES.map((harness) => (
                <DropdownMenuItem
                  key={harness.id}
                  onSelect={() => setTarget({ type: "new", harness })}
                >
                  New task · {harness.label}
                </DropdownMenuItem>
              ))}
              {liveTasks.map((meta) => (
                <DropdownMenuItem
                  key={meta.task.taskId}
                  onSelect={() =>
                    setTarget({ type: "task", taskId: meta.task.taskId })
                  }
                  className="gap-2"
                >
                  <StatusDot status={meta.task.status} />
                  <span className="max-w-64 truncate">{meta.task.title}</span>
                  <span className="ms-auto ps-3 text-[11px] text-muted-foreground">
                    {describeTaskMeta(meta)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ms-auto flex items-center gap-2">
            {confirmTrust && (
              <span className="text-[11px] text-amber-600 dark:text-amber-400">
                Spawns {target.type === "new" ? target.harness.label : "an agent"} with
                access to this folder — send again to trust.
              </span>
            )}
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!text.trim() || sending}
              className="size-8 rounded-xl"
              title="Send (⌘⏎)"
              aria-label="Send"
            >
              <ArrowUp />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
