import { describe, it, expect, afterEach } from "vitest";
import { withAdapterLogging } from "../logging-adapter";
import { setLogger, type LogEntry } from "@/utils/logger";
import type { IPlatformAdapter } from "../platform-adapter.interface";

function captureLogs(): LogEntry[] {
  const entries: LogEntry[] = [];
  setLogger({ log: (entry) => entries.push(entry) });
  return entries;
}

afterEach(() => setLogger(null));

const fakeAdapter = {
  async readFiles(paths: string[]) {
    return {
      succeeded: paths.map((path) => ({ path, content: "x" })),
      failed: [],
    };
  },
  async moveFile(oldPath: string) {
    return {
      ok: false as const,
      error: { path: oldPath, type: "not_found" as const, message: "missing" },
    };
  },
} as unknown as IPlatformAdapter;

describe("withAdapterLogging", () => {
  it("logs one entry per call with paths, duration, and outcome", async () => {
    const entries = captureLogs();
    const adapter = withAdapterLogging(fakeAdapter);

    await adapter.readFiles(["/ws/a.md"]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "adapter.readFiles",
      level: "debug",
      data: { args: [["/ws/a.md"]], ok: true, succeeded: 1 },
    });
    expect(entries[0].data?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs failed Results at warn level with the error message", async () => {
    const entries = captureLogs();
    const adapter = withAdapterLogging(fakeAdapter);

    await adapter.moveFile("/ws/a.md", "/ws/b.md");

    expect(entries[0]).toMatchObject({
      event: "adapter.moveFile",
      level: "warn",
      data: { ok: false, error: "missing" },
    });
  });

  it("stays silent when no logger is injected (default no-op)", async () => {
    setLogger(null);
    const adapter = withAdapterLogging(fakeAdapter);
    await expect(adapter.readFiles(["/ws/a.md"])).resolves.toBeTruthy();
  });
});
