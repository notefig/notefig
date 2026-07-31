import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams } from "react-router";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  RotateCw,
  ArrowRight,
  Trash2,
  ChevronDown,
  ChevronRight,
  Play,
  Square,
  X,
  Copy,
  Check,
  FileJson,
  AlertTriangle,
  ShieldOff,
} from "lucide-react";
import { platformAdapter } from "@/adapters";
import { SETTINGS_NAMESPACE } from "@/hooks/use-app-settings";
import type { LayoutNode } from "@/components/dockable";
// Pure zero-dependency leaf — safe for the crash fallback (unlike entity
// modules, which must never be runtime imports here).
import {
  LAYOUT_PARAM,
  parseLayout,
  extractTabIds,
  findLayoutSelectedTab,
} from "@/utils/layout-codec";
import {
  getEditor,
  isMarkdownInstance,
} from "@/components/editor/editor-store";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
// Type-only import — erased at runtime, so the crash panel stays
// self-sufficient (its only runtime dependency is the QueryClient).
import type { GitRow } from "@/entities/git";
import {
  agentEntriesCollection,
  agentPermissionRequestsCollection,
  agentTasksCollection,
  agentTurnsCollection,
} from "@/agent/agent-collections";

function useQueryCacheTick(): number {
  const queryClient = useQueryClient();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const unsubscribe = queryClient.getQueryCache().subscribe(() => {
      setTick((prev) => prev + 1);
    });
    return unsubscribe;
  }, [queryClient]);

  return tick;
}

interface ConsoleEntry {
  id: number;
  level: "log" | "info" | "warn" | "error";
  timestamp: number;
  message: string;
}

type ConsoleLevel = ConsoleEntry["level"];

const LEVEL_COLORS: Record<ConsoleLevel, string> = {
  log: "text-foreground",
  info: "text-blue-400",
  warn: "text-amber-400",
  error: "text-destructive",
};

const LEVEL_BG: Record<ConsoleLevel, string> = {
  log: "",
  info: "",
  warn: "bg-amber-500/5",
  error: "bg-destructive/5",
};

const MAX_CONSOLE_ENTRIES = 500;

const TELEMETRY_CONSENT_KEYS = [
  "telemetryConsentVersion",
  "crashReportingEnabled",
  "analyticsEnabled",
  "telemetryInstallId",
];

async function resetTelemetryConsent(): Promise<void> {
  for (const key of TELEMETRY_CONSENT_KEYS) {
    await platformAdapter.deleteKv(SETTINGS_NAMESPACE, key);
  }
  // Reload resets the bootstrap's module-level started flag, so the
  // first-run consent dialog reappears immediately.
  window.location.reload();
}

async function copyTextWithFallback(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for environments where clipboard API is blocked
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  }
}

function useConsoleCapture(active: boolean) {
  const entriesRef = useRef<ConsoleEntry[]>([]);
  const idCounterRef = useRef(0);
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const originalsRef = useRef<Record<
    ConsoleLevel,
    (...args: unknown[]) => void
  > | null>(null);

  const flush = useCallback(() => {
    setEntries([...entriesRef.current]);
  }, []);

  const clear = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
  }, []);

  useEffect(() => {
    if (!active) return;

    if (!originalsRef.current) {
      originalsRef.current = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
      };
    }

    const originals = originalsRef.current;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        flush();
      }, 100);
    };

    const capture = (level: ConsoleLevel) => {
      return (...args: unknown[]) => {
        originals[level](...args);

        const message = args
          .map((a) => {
            if (typeof a === "string") return a;
            try {
              return JSON.stringify(a, null, 2);
            } catch {
              return String(a);
            }
          })
          .join(" ");

        const entry: ConsoleEntry = {
          id: idCounterRef.current++,
          level,
          timestamp: Date.now(),
          message,
        };

        entriesRef.current.push(entry);
        if (entriesRef.current.length > MAX_CONSOLE_ENTRIES) {
          entriesRef.current = entriesRef.current.slice(-MAX_CONSOLE_ENTRIES);
        }

        scheduleFlush();
      };
    };

    console.log = capture("log");
    console.info = capture("info");
    console.warn = capture("warn");
    console.error = capture("error");

    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      console.log = originals.log;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
    };
  }, [active, flush]);

  return { entries, clear };
}

interface DebugPanelProps {
  /** When true, panel renders regardless of ?debug= search param */
  forceOpen?: boolean;
  /** Error to display (from error boundary) */
  error?: { message: string; stack?: string };
}

export function DebugPanel({ forceOpen, error }: DebugPanelProps) {
  const [searchParams, setUrlSearchParams] = useSearchParams();
  const isDebugOpen = searchParams.get("debug") === "true";
  const isOpen = forceOpen || isDebugOpen;

  if (!isOpen) return null;

  return (
    <DebugPanelContent
      error={error}
      forceOpen={forceOpen}
      onClose={
        forceOpen
          ? undefined
          : () => {
              setUrlSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete("debug");
                return next;
              });
            }
      }
      searchParams={searchParams}
    />
  );
}

function DebugPanelContent({
  error,
  forceOpen,
  onClose,
  searchParams,
}: {
  error?: { message: string; stack?: string };
  forceOpen?: boolean;
  onClose?: () => void;
  searchParams: URLSearchParams;
}) {
  const { basePath, "*": filePath } = useParams();

  const dockableLayout = useMemo(
    () => parseLayout(searchParams.get(LAYOUT_PARAM)),
    [searchParams],
  );
  const openTabs = useMemo(
    () => extractTabIds(dockableLayout),
    [dockableLayout],
  );
  const activeTabId = useMemo(
    () => findLayoutSelectedTab(dockableLayout),
    [dockableLayout],
  );
  useQueryCacheTick();
  const queryClient = useQueryClient();
  // Key hand-inlined on purpose (self-sufficiency): matches entities/git.ts's
  // gitQueryKey — the git collection stores its GitRow[] in the query cache.
  const gitStatusQueryKey = basePath ? (["git", basePath] as const) : null;
  const latestGitRows = gitStatusQueryKey
    ? (queryClient.getQueryData<GitRow[]>(gitStatusQueryKey) ?? null)
    : null;
  const latestGitRepoRow =
    latestGitRows?.find(
      (row): row is GitRow & { kind: "repo" } => row.kind === "repo",
    ) ?? null;
  const latestGitStatus = latestGitRows;
  const latestGitStatusError: { message: string } | null = gitStatusQueryKey
    ? ((queryClient.getQueryState(gitStatusQueryKey)?.error as Error | null) ??
      latestGitRepoRow?.statusError ??
      null)
    : null;
  const latestGitStatusUpdatedAt = gitStatusQueryKey
    ? (queryClient.getQueryState(gitStatusQueryKey)?.dataUpdatedAt ?? 0)
    : 0;

  const [isCapturing, setIsCapturing] = useState(false);
  const { entries: consoleEntries, clear: clearConsole } =
    useConsoleCapture(isCapturing);

  const [consoleFilter, setConsoleFilter] = useState("");
  const [activeLevels, setActiveLevels] = useState<Set<ConsoleLevel>>(
    new Set(["log", "info", "warn", "error"]),
  );

  const filteredEntries = useMemo(() => {
    return consoleEntries.filter((entry) => {
      if (!activeLevels.has(entry.level)) return false;
      if (consoleFilter) {
        try {
          const regex = new RegExp(consoleFilter, "i");
          return regex.test(entry.message);
        } catch {
          return entry.message
            .toLowerCase()
            .includes(consoleFilter.toLowerCase());
        }
      }
      return true;
    });
  }, [consoleEntries, consoleFilter, activeLevels]);

  const toggleLevel = (level: ConsoleLevel) => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) {
        next.delete(level);
      } else {
        next.add(level);
      }
      return next;
    });
  };

  const consoleEndRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [filteredEntries, autoScroll]);

  const currentRawUrl = window.location.pathname + window.location.search;
  const [urlDraft, setUrlDraft] = useState(currentRawUrl);

  const urlInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== urlInputRef.current) {
      setUrlDraft(window.location.pathname + window.location.search);
    }
  }, [searchParams]);

  const decodedPreview = useMemo(() => {
    try {
      return decodeURIComponent(urlDraft);
    } catch {
      return urlDraft;
    }
  }, [urlDraft]);

  const navigateToUrl = () => {
    const target = urlDraft.trim();
    if (target && target !== currentRawUrl) {
      window.location.href = target;
    }
  };

  const [copied, setCopied] = useState(false);

  const buildDebugReport = useCallback(() => {
    const rawUrl = window.location.pathname + window.location.search;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawUrl);
    } catch {
      decoded = rawUrl;
    }

    const lines: string[] = [];
    lines.push("=== Metrists Debug Report ===");
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push(`User Agent: ${navigator.userAgent}`);
    lines.push("");

    if (error) {
      lines.push("── Error ──");
      lines.push(`Message: ${error.message}`);
      if (error.stack) {
        lines.push(`Stack:\n${error.stack}`);
      }
      lines.push("");
    }

    lines.push("── Route State ──");
    lines.push(`URL (raw): ${rawUrl}`);
    if (decoded !== rawUrl) {
      lines.push(`URL (decoded): ${decoded}`);
    }
    lines.push(`basePath: ${basePath || "undefined"}`);
    lines.push(`filePath: ${filePath || "undefined"}`);

    const displayParams = new URLSearchParams(searchParams);
    displayParams.delete("debug");
    lines.push(`searchParams: ${displayParams.toString() || "(none)"}`);
    lines.push("");

    lines.push("── Open Tabs ──");
    lines.push(`Count: ${openTabs.length}`);
    lines.push(`Active: ${activeTabId || "null"}`);
    openTabs.forEach((tab) => {
      const marker = tab === activeTabId ? " (active)" : "";
      lines.push(`  - ${tab}${marker}`);
    });
    lines.push("");

    if (dockableLayout.length > 0) {
      lines.push("── Dockable Layout ──");
      lines.push(JSON.stringify(dockableLayout, null, 2));
      lines.push("");
    }

    lines.push("── Git Status Cache ──");
    lines.push(
      `updatedAt: ${latestGitStatusUpdatedAt ? new Date(latestGitStatusUpdatedAt).toISOString() : "(none)"}`,
    );
    if (latestGitStatusError) {
      lines.push(`error: ${latestGitStatusError.message}`);
    }
    lines.push(JSON.stringify(latestGitStatus, null, 2));
    lines.push("");

    if (consoleEntries.length > 0) {
      lines.push(`── Console Output (${consoleEntries.length} entries) ──`);
      consoleEntries.forEach((entry) => {
        const time = new Date(entry.timestamp).toLocaleTimeString("en-US", {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        lines.push(`[${time}] [${entry.level.toUpperCase()}] ${entry.message}`);
      });
      lines.push("");
    }

    lines.push("=== End Debug Report ===");
    return lines.join("\n");
  }, [
    basePath,
    filePath,
    searchParams,
    openTabs,
    activeTabId,
    dockableLayout,
    latestGitStatus,
    latestGitStatusError,
    latestGitStatusUpdatedAt,
    consoleEntries,
    error,
  ]);

  const copyDebugReport = useCallback(async () => {
    await copyTextWithFallback(buildDebugReport());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [buildDebugReport]);

  const [astCopied, setAstCopied] = useState(false);
  const [showAstWarning, setShowAstWarning] = useState(false);

  const buildPlateAstReport = useCallback(() => {
    interface FileReport {
      type: string;
      ast?: unknown;
      content?: string;
      note?: string;
    }

    const files: Record<string, FileReport> = {};

    for (const tabPath of openTabs) {
      const editor = getEditor(tabPath);
      if (isMarkdownInstance(editor)) {
        files[tabPath] = {
          type: "markdown",
          ast: editor.editor.getJSON(),
        };
      } else {
        files[tabPath] = {
          type: editor?.type || "unknown",
          note: "No AST available for this file type",
        };
      }
    }

    const report = {
      timestamp: new Date().toISOString(),
      files,
    };

    return JSON.stringify(report, null, 2);
  }, [openTabs]);

  const copyPlateAst = useCallback(async () => {
    await copyTextWithFallback(buildPlateAstReport());
    setAstCopied(true);
    setTimeout(() => setAstCopied(false), 2000);
  }, [buildPlateAstReport]);

  const workspacePath = basePath ? decodeURIComponent(basePath) : null;

  // Query everything unconditionally (rules of hooks) and filter client-side —
  // this is a debug view, not a hot path, so a full-collection subscription
  // plus useMemo filtering is simpler than juggling conditional queries.
  const { data: allTasks = [] } = useLiveQuery((q) =>
    q.from({ task: agentTasksCollection }),
  );
  const { data: allTurns = [] } = useLiveQuery((q) =>
    q.from({ turn: agentTurnsCollection }),
  );
  const { data: allEntries = [] } = useLiveQuery((q) =>
    q.from({ entry: agentEntriesCollection }),
  );
  const { data: allPermissionRequests = [] } = useLiveQuery((q) =>
    q.from({ req: agentPermissionRequestsCollection }),
  );

  const workspaceTasks = useMemo(
    () =>
      [...allTasks]
        .filter((task) => !workspacePath || task.workspacePath === workspacePath)
        // Newest-first (task ids sort descending by construction).
        .sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    [allTasks, workspacePath],
  );

  const [selectedSessionTaskId, setSelectedSessionTaskId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (
      selectedSessionTaskId &&
      workspaceTasks.some((task) => task.taskId === selectedSessionTaskId)
    ) {
      return;
    }
    setSelectedSessionTaskId(workspaceTasks[0]?.taskId ?? null);
  }, [workspaceTasks, selectedSessionTaskId]);

  const sessionTask = useMemo(
    () => allTasks.find((task) => task.taskId === selectedSessionTaskId) ?? null,
    [allTasks, selectedSessionTaskId],
  );
  const sessionTurns = useMemo(
    () =>
      allTurns
        .filter((turn) => turn.taskId === selectedSessionTaskId)
        .sort((a, b) => (a.turnId < b.turnId ? -1 : 1)),
    [allTurns, selectedSessionTaskId],
  );
  const sessionEntries = useMemo(
    () =>
      allEntries
        .filter((entry) => entry.taskId === selectedSessionTaskId)
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    [allEntries, selectedSessionTaskId],
  );
  const sessionPermissionRequests = useMemo(
    () => allPermissionRequests.filter((req) => req.taskId === selectedSessionTaskId),
    [allPermissionRequests, selectedSessionTaskId],
  );
  const buildSessionReport = useCallback(() => {
    if (!sessionTask) return "(no task selected)";

    const lines: string[] = [];
    lines.push("=== Metrists Agent Session Report ===");
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");

    lines.push("── Task ──");
    lines.push(`taskId: ${sessionTask.taskId}`);
    if (sessionTask.parentTaskId) {
      lines.push(`parentTaskId: ${sessionTask.parentTaskId}`);
    }
    lines.push(`workspacePath: ${sessionTask.workspacePath}`);
    lines.push(`title: ${sessionTask.title}`);
    lines.push(`status: ${sessionTask.status}`);
    lines.push(`harnessId: ${sessionTask.harnessId}`);
    lines.push(`createdAt: ${new Date(sessionTask.createdAt).toISOString()}`);
    if (sessionTask.authHint) {
      lines.push(`authHint: ${sessionTask.authHint}`);
    }
    lines.push("");

    lines.push(`── Turns (${sessionTurns.length}) ──`);
    for (const turn of sessionTurns) {
      lines.push(
        `[${turn.turnId}] status=${turn.status}${turn.stopReason ? ` stopReason=${turn.stopReason}` : ""}${turn.error ? ` error=${turn.error}` : ""} startedAt=${new Date(turn.startedAt).toISOString()}`,
      );
    }
    lines.push("");

    lines.push(`── Transcript (${sessionEntries.length} entries) ──`);
    for (const entry of sessionEntries) {
      // Replayed entries carry no createdAt (MET-94) — and toISOString()
      // on an Invalid Date throws, so this guard keeps the report alive.
      const time =
        entry.createdAt !== undefined
          ? new Date(entry.createdAt).toISOString()
          : "replayed";
      switch (entry.type) {
        case "user":
        case "assistant":
          lines.push(`[${time}] [${entry.type.toUpperCase()}] ${entry.text ?? ""}`);
          break;
        case "tool_call":
          lines.push(
            `[${time}] [TOOL_CALL] ${entry.toolCall?.title ?? entry.toolCallId ?? "(untitled)"} status=${entry.toolCall?.status ?? "unknown"}`,
          );
          if (entry.toolCall?.rawInput) {
            lines.push(`  input: ${JSON.stringify(entry.toolCall.rawInput)}`);
          }
          if (entry.toolCall?.content) {
            lines.push(`  content: ${JSON.stringify(entry.toolCall.content)}`);
          }
          break;
        case "plan":
          lines.push(`[${time}] [PLAN] ${JSON.stringify(entry.plan)}`);
          break;
        default:
          lines.push(
            `[${time}] [${entry.type.toUpperCase()}] ${entry.text ?? ""} ${entry.raw ? JSON.stringify(entry.raw) : ""}`.trimEnd(),
          );
      }
    }
    lines.push("");

    if (sessionPermissionRequests.length > 0) {
      lines.push(`── Permission requests (${sessionPermissionRequests.length}) ──`);
      for (const req of sessionPermissionRequests) {
        lines.push(`[${req.id}] ${req.title} status=${req.status}`);
      }
      lines.push("");
    }

    lines.push("=== End Session Report ===");
    return lines.join("\n");
  }, [sessionTask, sessionTurns, sessionEntries, sessionPermissionRequests]);

  const [sessionCopied, setSessionCopied] = useState(false);

  const copySessionReport = useCallback(async () => {
    await copyTextWithFallback(buildSessionReport());
    setSessionCopied(true);
    setTimeout(() => setSessionCopied(false), 2000);
  }, [buildSessionReport]);

  const [showLayout, setShowLayout] = useState(false);
  const [activeTab, setActiveTab] = useState<"state" | "console" | "session">(
    error ? "state" : "state",
  );

  const displaySearchParams = new URLSearchParams(searchParams);
  displaySearchParams.delete("debug");
  const searchParamsStr = displaySearchParams.toString();

  return (
    <div
      className={cn(
        "bg-card/95 backdrop-blur-sm border-border text-foreground font-mono text-xs flex flex-col overflow-hidden texture-surface",
        forceOpen ? "h-full" : "max-h-[40vh]",
      )}
    >
      {error && (
        <div className="px-3 py-2 bg-destructive/10 border-b border-destructive/30 shrink-0">
          <div className="text-destructive font-semibold text-xs mb-1">
            Workspace crashed
          </div>
          <div className="text-destructive/80 text-[11px] break-all">
            {error.message}
          </div>
          {error.stack && (
            <pre className="mt-1 text-[10px] text-destructive/60 whitespace-pre-wrap break-all max-h-32 overflow-auto">
              {error.stack}
            </pre>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={() => window.location.reload()}
            >
              Reload page
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px] border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={copyDebugReport}
            >
              {copied ? "Copied!" : "Copy debug report"}
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-muted/50 shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setActiveTab("state")}
            className={cn(
              "px-2 py-0.5 rounded text-xs transition-colors",
              activeTab === "state"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            State
          </button>
          <button
            onClick={() => setActiveTab("console")}
            className={cn(
              "px-2 py-0.5 rounded text-xs transition-colors",
              activeTab === "console"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Console
            {consoleEntries.length > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground">
                ({consoleEntries.length})
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("session")}
            className={cn(
              "px-2 py-0.5 rounded text-xs transition-colors",
              activeTab === "session"
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Session
            {workspaceTasks.length > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground">
                ({workspaceTasks.length})
              </span>
            )}
          </button>
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={copyDebugReport}
            title="Copy debug report to clipboard"
          >
            {copied ? (
              <Check className="h-3 w-3 text-green-500" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setShowAstWarning(true)}
            title="Copy Plate AST (includes file content!)"
          >
            <FileJson className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={resetTelemetryConsent}
            title="Reset telemetry consent and reload (shows the first-run dialog again)"
          >
            <ShieldOff className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => window.location.reload()}
            title="Reload page"
          >
            <RotateCw className="h-3 w-3" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onClose}
              title="Close debug panel"
            >
              <X className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>

      {showAstWarning && (
        <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 shrink-0">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-amber-700 dark:text-amber-400 font-semibold text-xs mb-1">
                Warning: File content will be copied
              </div>
              <div className="text-amber-600/80 dark:text-amber-300/70 text-[11px] mb-2">
                The Plate AST includes the full content of your open files. Only
                share this with trusted parties.
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[11px] border-amber-500/30 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
                  onClick={() => {
                    copyPlateAst();
                    setShowAstWarning(false);
                  }}
                >
                  {astCopied ? (
                    <>
                      <Check className="h-3 w-3 mr-1" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3 mr-1" />
                      Copy anyway
                    </>
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => setShowAstWarning(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="px-3 py-1.5 border-b border-border bg-muted/30 shrink-0 space-y-1">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider shrink-0">
            URL
          </span>
          <Input
            ref={urlInputRef}
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigateToUrl();
            }}
            className="h-6 text-xs font-mono bg-background border-border px-1.5 py-0 flex-1"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={navigateToUrl}
            title="Navigate"
          >
            <ArrowRight className="h-3 w-3" />
          </Button>
        </div>
        {decodedPreview !== urlDraft && (
          <div className="text-[10px] text-muted-foreground truncate pl-7">
            Decoded: {decodedPreview}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0">
        {activeTab === "state" ? (
          <div className="p-3 space-y-2">
            <div className="space-y-1">
              <Row label="Current URL (raw)">
                {window.location.pathname}
                {window.location.search}
              </Row>
              <Row label="Decoded">
                {decodeURIComponent(
                  window.location.pathname + window.location.search,
                )}
              </Row>
              <Row label="basePath">{basePath || "undefined"}</Row>
              <Row label="filePath (*)">{filePath || "undefined"}</Row>
              <Row label="searchParams">{searchParamsStr || "(none)"}</Row>
            </div>

            <div className="border-t border-border pt-2">
              <Row label={`openTabs (${openTabs.length})`}>
                {openTabs.length === 0 ? "(none)" : ""}
              </Row>
              {openTabs.length > 0 && (
                <ul className="ml-4 mt-1 space-y-0.5">
                  {openTabs.map((tab) => (
                    <li
                      key={tab}
                      className={cn(
                        "text-[11px] break-all",
                        tab === activeTabId
                          ? "text-foreground font-medium"
                          : "text-muted-foreground",
                      )}
                    >
                      {tab}
                      {tab === activeTabId && (
                        <span className="text-primary ml-1">(active)</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <Row label="activeTabId">{activeTabId || "null"}</Row>
            </div>

            {dockableLayout.length > 0 && (
              <div className="border-t border-border pt-2">
                <button
                  onClick={() => setShowLayout(!showLayout)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showLayout ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  Dockable Layout
                </button>
                {showLayout && (
                  <pre className="mt-1 p-2 rounded bg-muted text-[10px] leading-tight whitespace-pre-wrap break-all border border-border select-text">
                    {JSON.stringify(dockableLayout, null, 2)}
                  </pre>
                )}
              </div>
            )}

            <div className="border-t border-border pt-2">
              <Row label="gitStatus.updatedAt">
                {latestGitStatusUpdatedAt
                  ? new Date(latestGitStatusUpdatedAt).toISOString()
                  : "(none)"}
              </Row>
              {latestGitStatusError ? (
                <Row label="gitStatus.error">
                  {latestGitStatusError.message}
                </Row>
              ) : null}
              <pre className="mt-1 rounded bg-muted p-2 text-[10px] leading-tight whitespace-pre-wrap break-all border border-border select-text">
                {JSON.stringify(latestGitStatus, null, 2)}
              </pre>
            </div>
          </div>
        ) : activeTab === "session" ? (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0">
              <span className="text-muted-foreground text-[10px] uppercase tracking-wider shrink-0">
                Task
              </span>
              <select
                value={selectedSessionTaskId ?? ""}
                onChange={(e) => setSelectedSessionTaskId(e.target.value || null)}
                className="h-6 text-[11px] font-mono bg-background border border-border rounded px-1.5 flex-1 min-w-0"
              >
                {workspaceTasks.length === 0 && (
                  <option value="">(no tasks in this workspace)</option>
                )}
                {workspaceTasks.map((task) => (
                  <option key={task.taskId} value={task.taskId}>
                    [{task.status}] {task.title} — {task.taskId}
                  </option>
                ))}
              </select>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={copySessionReport}
                title="Copy session transcript to clipboard"
                disabled={!sessionTask}
              >
                {sessionCopied ? (
                  <Check className="h-3 w-3 text-green-500" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
              </Button>
            </div>

            <div className="flex-1 overflow-auto min-h-0 p-3">
              {!sessionTask ? (
                <div className="flex items-center justify-center h-full p-4 text-muted-foreground text-[11px]">
                  No agent session in this workspace yet.
                </div>
              ) : (
                <pre className="text-[10px] leading-tight whitespace-pre-wrap break-all select-text">
                  {buildSessionReport()}
                </pre>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0">
              <Button
                variant={isCapturing ? "secondary" : "ghost"}
                size="icon"
                className="h-6 w-6"
                onClick={() => setIsCapturing(!isCapturing)}
                title={isCapturing ? "Stop capturing" : "Start capturing"}
              >
                {isCapturing ? (
                  <Square className="h-2.5 w-2.5" />
                ) : (
                  <Play className="h-3 w-3" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={clearConsole}
                title="Clear console"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
              <div className="flex items-center gap-0.5 ml-1">
                {(["log", "info", "warn", "error"] as ConsoleLevel[]).map(
                  (level) => (
                    <button
                      key={level}
                      onClick={() => toggleLevel(level)}
                      className={cn(
                        "px-1.5 py-0.5 rounded text-[10px] transition-colors",
                        activeLevels.has(level)
                          ? cn("bg-accent", LEVEL_COLORS[level])
                          : "text-muted-foreground/50 line-through",
                      )}
                    >
                      {level}
                    </button>
                  ),
                )}
              </div>
              <Input
                value={consoleFilter}
                onChange={(e) => setConsoleFilter(e.target.value)}
                placeholder="Filter (regex)..."
                className="h-6 text-[11px] font-mono bg-background border-border px-1.5 py-0 flex-1 ml-1"
              />
              <button
                onClick={() => setAutoScroll(!autoScroll)}
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded transition-colors whitespace-nowrap",
                  autoScroll
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="Toggle auto-scroll"
              >
                auto-scroll
              </button>
            </div>

            <div className="flex-1 overflow-auto min-h-0">
              {!isCapturing && consoleEntries.length === 0 ? (
                <div className="flex items-center justify-center h-full p-4 text-muted-foreground text-[11px]">
                  Press play to start capturing console output
                </div>
              ) : filteredEntries.length === 0 ? (
                <div className="flex items-center justify-center h-full p-4 text-muted-foreground text-[11px]">
                  {consoleEntries.length > 0
                    ? "No entries match the current filter"
                    : "No console output captured yet"}
                </div>
              ) : (
                <div className="divide-y divide-border/50">
                  {filteredEntries.map((entry) => (
                    <div
                      key={entry.id}
                      className={cn(
                        "px-3 py-0.5 flex gap-2 items-start select-text",
                        LEVEL_BG[entry.level],
                      )}
                    >
                      <span className="text-muted-foreground text-[10px] shrink-0 tabular-nums pt-px">
                        {new Date(entry.timestamp).toLocaleTimeString("en-US", {
                          hour12: false,
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      <span
                        className={cn(
                          "text-[11px] whitespace-pre-wrap break-all",
                          LEVEL_COLORS[entry.level],
                        )}
                      >
                        {entry.message}
                      </span>
                    </div>
                  ))}
                  <div ref={consoleEndRef} />
                </div>
              )}
            </div>
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2 text-[11px]">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="text-foreground break-all">{children}</span>
    </div>
  );
}
