import { describe, expect, it } from "vitest";
import { formatDebugReport, trimDebugReport, type DebugReportInput } from "./debug-report";

function input(overrides: Partial<DebugReportInput> = {}): DebugReportInput {
  return {
    basePath: "/Users/someone/notes",
    searchParams: new URLSearchParams("debug=true&sidebar=files"),
    dockableLayout: [],
    openTabs: ["/Users/someone/notes/a.md", "/Users/someone/notes/b.md"],
    activeTabId: "/Users/someone/notes/b.md",
    git: { rows: null, error: { message: "not a repo" }, updatedAt: 0 },
    rawUrl: "/?sidebar=files%20x",
    userAgent: "TestAgent/1",
    now: new Date(Date.UTC(2026, 9, 16, 12)),
    console: [],
    ...overrides,
  };
}

describe("formatDebugReport", () => {
  it("writes the debug panel's report", () => {
    expect(formatDebugReport(input())).toBe(
      [
        "=== Notefig Debug Report ===",
        "Timestamp: 2026-10-16T12:00:00.000Z",
        "User Agent: TestAgent/1",
        "",
        "── Route State ──",
        "URL (raw): /?sidebar=files%20x",
        "URL (decoded): /?sidebar=files x",
        "basePath: /Users/someone/notes",
        "searchParams: sidebar=files",
        "",
        "── Open Tabs ──",
        "Count: 2",
        "Active: /Users/someone/notes/b.md",
        "  - /Users/someone/notes/a.md",
        "  - /Users/someone/notes/b.md (active)",
        "",
        "── Git Status Cache ──",
        "updatedAt: (none)",
        "error: not a repo",
        "null",
        "",
        "=== End Debug Report ===",
      ].join("\n"),
    );
  });

  it("includes a crash's error and the captured console", () => {
    const report = formatDebugReport(
      input({
        error: { message: "boom", stack: "at x" },
        console: [{ id: 0, level: "warn", timestamp: Date.UTC(2026, 9, 16, 12), message: "careful" }],
      }),
    );
    expect(report).toContain("── Error ──\nMessage: boom\nStack:\nat x");
    expect(report).toMatch(/── Console Output \(1 entries\) ──\n\[\d\d:\d\d:\d\d\] \[WARN\] careful/);
  });
});

describe("trimDebugReport", () => {
  it("leaves a short report alone", () => {
    expect(trimDebugReport("short", 100)).toBe("short");
  });

  it("keeps the start and the end of a long one, within the limit", () => {
    const report = `START${"x".repeat(10_000)}END`;
    const trimmed = trimDebugReport(report, 1_000);
    expect(trimmed.length).toBeLessThanOrEqual(1_000);
    expect(trimmed.startsWith("START")).toBe(true);
    expect(trimmed.endsWith("END")).toBe(true);
    expect(trimmed).toContain("characters cut");
  });
});
