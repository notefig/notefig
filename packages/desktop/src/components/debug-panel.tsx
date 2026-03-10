import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useParams, useSearchParams } from "react-router";
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
} from "lucide-react";
import type { LayoutNode } from "@/components/dockable";

// ── Types ──

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

// ── Console capture hook ──

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

    // Save originals once
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
        // Call original
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
      // Restore originals
      console.log = originals.log;
      console.info = originals.info;
      console.warn = originals.warn;
      console.error = originals.error;
    };
  }, [active, flush]);

  return { entries, clear };
}

// ── Debug Panel ──

interface DebugPanelProps {
  openTabs?: string[];
  activeTabId?: string | null;
  dockableLayout?: LayoutNode[];
}

export function DebugPanel({
  openTabs,
  activeTabId,
  dockableLayout,
}: DebugPanelProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const isOpen = searchParams.get("debug") === "true";

  if (!isOpen) return null;

  return (
    <DebugPanelContent
      openTabs={openTabs}
      activeTabId={activeTabId}
      dockableLayout={dockableLayout}
      onClose={() => {
        setSearchParams((prev) => {
          prev.delete("debug");
          return prev;
        });
      }}
    />
  );
}

function DebugPanelContent({
  openTabs,
  activeTabId,
  dockableLayout,
  onClose,
}: DebugPanelProps & { onClose: () => void }) {
  const { basePath, "*": filePath } = useParams();
  const [searchParams] = useSearchParams();

  // ── Console capture ──
  const [isCapturing, setIsCapturing] = useState(false);
  const { entries: consoleEntries, clear: clearConsole } =
    useConsoleCapture(isCapturing);

  // ── Console filters ──
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

  // ── Auto-scroll ──
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [filteredEntries, autoScroll]);

  // ── URL editor ──
  const [urlDraft, setUrlDraft] = useState(() =>
    decodeURIComponent(window.location.pathname + window.location.search),
  );

  // Keep draft in sync when URL changes externally (but not while user is editing)
  const urlInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== urlInputRef.current) {
      setUrlDraft(
        decodeURIComponent(window.location.pathname + window.location.search),
      );
    }
  }, [searchParams]);

  const navigateToUrl = () => {
    const encoded = urlDraft
      .split("/")
      .map((segment) => {
        if (segment === "") return "";
        // Don't double-encode already-encoded segments
        try {
          const decoded = decodeURIComponent(segment);
          return encodeURIComponent(decoded);
        } catch {
          return encodeURIComponent(segment);
        }
      })
      .join("/");

    // Preserve query string if present in draft
    const qIndex = urlDraft.indexOf("?");
    if (qIndex !== -1) {
      const path = urlDraft.slice(0, qIndex);
      const query = urlDraft.slice(qIndex);
      const encodedPath = path
        .split("/")
        .map((s) => {
          if (s === "") return "";
          try {
            return encodeURIComponent(decodeURIComponent(s));
          } catch {
            return encodeURIComponent(s);
          }
        })
        .join("/");
      window.location.href = encodedPath + query;
    } else {
      window.location.href = encoded;
    }
  };

  // ── Collapsible sections ──
  const [showLayout, setShowLayout] = useState(false);
  const [activeTab, setActiveTab] = useState<"state" | "console">("state");

  // Build search params string without 'debug' for cleaner display
  const displaySearchParams = new URLSearchParams(searchParams);
  displaySearchParams.delete("debug");
  const searchParamsStr = displaySearchParams.toString();

  return (
    <div className="bg-card/95 backdrop-blur-sm border-b border-border text-foreground font-mono text-xs flex flex-col max-h-[40vh] overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-muted/50 shrink-0">
        <div className="flex items-center gap-1">
          {/* Tab switcher */}
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
        </div>

        <div className="flex items-center gap-1">
          {/* Reload */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => window.location.reload()}
            title="Reload page"
          >
            <RotateCw className="h-3 w-3" />
          </Button>
          {/* Close */}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            title="Close debug panel"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* ── URL Editor ── */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border bg-muted/30 shrink-0">
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

      {/* ── Tab Content ── */}
      <ScrollArea className="flex-1 min-h-0">
        {activeTab === "state" ? (
          <div className="p-3 space-y-2">
            {/* Route state */}
            <div className="space-y-1">
              <Row label="Current URL">
                {window.location.pathname}
                {window.location.search}
              </Row>
              <Row label="basePath">{basePath || "undefined"}</Row>
              <Row label="filePath (*)">{filePath || "undefined"}</Row>
              <Row label="searchParams">{searchParamsStr || "(none)"}</Row>
            </div>

            {/* Tab state */}
            {openTabs !== undefined && (
              <>
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
              </>
            )}

            {/* Dockable layout */}
            {dockableLayout !== undefined && (
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
          </div>
        ) : (
          <div className="flex flex-col h-full">
            {/* Console controls */}
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0">
              {/* Capture toggle */}
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
              {/* Clear */}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={clearConsole}
                title="Clear console"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
              {/* Level filters */}
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
              {/* Filter */}
              <Input
                value={consoleFilter}
                onChange={(e) => setConsoleFilter(e.target.value)}
                placeholder="Filter (regex)..."
                className="h-6 text-[11px] font-mono bg-background border-border px-1.5 py-0 flex-1 ml-1"
              />
              {/* Auto-scroll toggle */}
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

            {/* Console entries */}
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

// ── Helpers ──

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
