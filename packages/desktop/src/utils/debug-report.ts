/**
 * The debug report's text: what the debug panel copies and what feedback
 * can attach. A pure leaf with type-only imports, so the crash fallback
 * that renders the panel can still use it.
 */
import type { LayoutNode } from "@/components/dockable";
import type { GitRow } from "@/modules/git";

export interface DebugConsoleEntry {
  level: "log" | "info" | "warn" | "error";
  timestamp: number;
  message: string;
}

/** The app's state the report describes (`useDebugSnapshot`). */
export interface DebugSnapshot {
  basePath: string | undefined;
  searchParams: URLSearchParams;
  dockableLayout: LayoutNode[];
  openTabs: string[];
  activeTabId: string | null;
  git: {
    rows: GitRow[] | null;
    error: { message: string } | null;
    updatedAt: number;
  };
}

export function formatDebugReport(
  snapshot: DebugSnapshot,
  {
    error,
    consoleEntries = [],
  }: {
    error?: { message: string; stack?: string };
    consoleEntries?: readonly DebugConsoleEntry[];
  } = {},
): string {
  const { basePath, searchParams, dockableLayout, openTabs, activeTabId, git } =
    snapshot;
  const rawUrl = window.location.pathname + window.location.search;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    decoded = rawUrl;
  }

  const lines: string[] = [];
  lines.push("=== Notefig Debug Report ===");
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
    `updatedAt: ${git.updatedAt ? new Date(git.updatedAt).toISOString() : "(none)"}`,
  );
  if (git.error) {
    lines.push(`error: ${git.error.message}`);
  }
  lines.push(JSON.stringify(git.rows, null, 2));
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
}
