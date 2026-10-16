/**
 * The debug report: the text the debug panel's "Copy debug report" puts on
 * the clipboard, and what feedback includes when the user ticks "Include
 * debug report". One formatter, so the two are always the same text.
 *
 * Pure, with type-only imports, so the debug panel — the crash fallback,
 * which must not depend on the modules that might have crashed — can use it.
 */
import type { LayoutNode } from "@/components/dockable";
import type { GitRow } from "@/modules/git";

/** A console line the debug panel captured while recording. */
export interface ConsoleEntry {
  id: number;
  level: "log" | "info" | "warn" | "error";
  timestamp: number;
  message: string;
}

export interface DebugSnapshot {
  /** The focused workspace. */
  basePath: string | undefined;
  searchParams: URLSearchParams;
  dockableLayout: LayoutNode[];
  openTabs: string[];
  activeTabId: string | null;
  git: {
    rows: GitRow[] | null;
    error: { message: string } | null;
    /** Epoch ms; 0 when never loaded. */
    updatedAt: number;
  };
}

export interface DebugReportInput extends DebugSnapshot {
  /** `location.pathname + location.search` */
  rawUrl: string;
  userAgent: string;
  now: Date;
  /** The error a crash fallback is showing. */
  error?: { message: string; stack?: string };
  console: readonly ConsoleEntry[];
}

function decode(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function consoleTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatDebugReport(input: DebugReportInput): string {
  const lines: string[] = [];
  lines.push("=== Notefig Debug Report ===");
  lines.push(`Timestamp: ${input.now.toISOString()}`);
  lines.push(`User Agent: ${input.userAgent}`);
  lines.push("");

  if (input.error) {
    lines.push("── Error ──");
    lines.push(`Message: ${input.error.message}`);
    if (input.error.stack) {
      lines.push(`Stack:\n${input.error.stack}`);
    }
    lines.push("");
  }

  const decoded = decode(input.rawUrl);
  lines.push("── Route State ──");
  lines.push(`URL (raw): ${input.rawUrl}`);
  if (decoded !== input.rawUrl) {
    lines.push(`URL (decoded): ${decoded}`);
  }
  lines.push(`basePath: ${input.basePath || "undefined"}`);

  const displayParams = new URLSearchParams(input.searchParams);
  displayParams.delete("debug");
  lines.push(`searchParams: ${displayParams.toString() || "(none)"}`);
  lines.push("");

  lines.push("── Open Tabs ──");
  lines.push(`Count: ${input.openTabs.length}`);
  lines.push(`Active: ${input.activeTabId || "null"}`);
  input.openTabs.forEach((tab) => {
    const marker = tab === input.activeTabId ? " (active)" : "";
    lines.push(`  - ${tab}${marker}`);
  });
  lines.push("");

  if (input.dockableLayout.length > 0) {
    lines.push("── Dockable Layout ──");
    lines.push(JSON.stringify(input.dockableLayout, null, 2));
    lines.push("");
  }

  lines.push("── Git Status Cache ──");
  lines.push(
    `updatedAt: ${input.git.updatedAt ? new Date(input.git.updatedAt).toISOString() : "(none)"}`,
  );
  if (input.git.error) {
    lines.push(`error: ${input.git.error.message}`);
  }
  lines.push(JSON.stringify(input.git.rows, null, 2));
  lines.push("");

  if (input.console.length > 0) {
    lines.push(`── Console Output (${input.console.length} entries) ──`);
    input.console.forEach((entry) => {
      lines.push(`[${consoleTime(entry.timestamp)}] [${entry.level.toUpperCase()}] ${entry.message}`);
    });
    lines.push("");
  }

  lines.push("=== End Debug Report ===");
  return lines.join("\n");
}

/**
 * `report` cut to `maxChars`, keeping its start (the app's state) and its
 * end (the latest console lines), with a line saying what was cut.
 */
export function trimDebugReport(report: string, maxChars: number): string {
  if (report.length <= maxChars) return report;
  const marker = `\n… ${report.length - maxChars} characters cut …\n`;
  const room = maxChars - marker.length;
  const head = Math.floor(room * 0.4);
  return report.slice(0, head) + marker + report.slice(report.length - (room - head));
}
