import { describe, it, expect, vi, beforeEach } from "vitest";
import { discoverHarnesses } from "../harness-discovery";

const runShellCommand = vi.fn();
const proc = { runShellCommand };

beforeEach(() => {
  runShellCommand.mockReset();
});

describe("discoverHarnesses", () => {
  it("parses sentinel-delimited output into per-id found/resolvedPath", async () => {
    runShellCommand.mockResolvedValue({
      stdout: "__MHD0__/usr/bin/foo__END____MHD1____END__",
      exitCode: 0,
    });
    const results = (await discoverHarnesses(proc, [
      { id: "a", command: "foo" },
      { id: "b", command: "bar" },
    ]))!;
    expect(results.a).toMatchObject({
      harnessId: "a",
      found: true,
      resolvedPath: "/usr/bin/foo",
    });
    expect(results.b).toMatchObject({ harnessId: "b", found: false });
    expect(results.b.resolvedPath).toBeUndefined();
  });

  it("batches every command into a single runShellCommand call", async () => {
    runShellCommand.mockResolvedValue({ stdout: "", exitCode: 0 });
    await discoverHarnesses(proc, [
      { id: "a", command: "foo" },
      { id: "b", command: "bar" },
      { id: "c", command: "baz" },
    ]);
    expect(runShellCommand).toHaveBeenCalledTimes(1);
  });

  it("returns null when the probe can't run — never an affirmative not-found", async () => {
    runShellCommand.mockRejectedValue(
      new Error("Shell commands are not supported on this adapter."),
    );
    const results = await discoverHarnesses(proc, [
      { id: "a", command: "foo" },
      { id: "b", command: "bar" },
    ]);
    expect(results).toBeNull();
  });

  it("returns {} without calling the adapter for an empty entry list", async () => {
    const results = await discoverHarnesses(proc, []);
    expect(results).toEqual({});
    expect(runShellCommand).not.toHaveBeenCalled();
  });

  it("uses a definition's probeCommand instead of the command -v default", async () => {
    runShellCommand.mockResolvedValue({ stdout: "", exitCode: 0 });
    await discoverHarnesses(proc, [
      { id: "a", command: "npx", probeCommand: "command -v claude" },
      { id: "b", command: "bar" },
    ]);
    const script = runShellCommand.mock.calls[0][0] as string;
    expect(script).toContain("command -v claude");
    expect(script).not.toContain("command -v 'npx'");
    expect(script).toContain("command -v 'bar'");
  });
});
