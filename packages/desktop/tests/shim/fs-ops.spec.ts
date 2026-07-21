import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * MET-83 Phase 4 — filesystem guardrails through the real Rust backend.
 *
 * Where `fs-roundtrip.spec.ts` drives the fs commands through the app UI, this
 * suite hits the `test-shim` binary's `POST /invoke/{cmd}` endpoint directly —
 * the same production dispatch path (`register_handlers` → MockRuntime →
 * `get_ipc_response`) the app uses, minus the browser. That lets us assert every
 * `fs_ops` command behaves as expected against a real temp filesystem, with
 * Node's `fs` as the ground-truth oracle in both directions:
 *   - app op (shim)      → verified on disk (Node fs)
 *   - state seeded on disk → verified by app-reported result (shim)
 *
 * The shim is booted by `playwright.shim.config.ts` (webServer) on SHIM_PORT.
 */
const SHIM_PORT = Number(process.env.SHIM_PORT ?? 4599);
const SHIM_URL = `http://127.0.0.1:${SHIM_PORT}`;

interface InvokeResult {
  status: number;
  body: unknown;
}

/** Call a Rust command exactly as the frontend transport does (text/plain body). */
async function invoke(cmd: string, args: unknown): Promise<InvokeResult> {
  const res = await fetch(`${SHIM_URL}/invoke/${cmd}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(args ?? {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

type BatchResult = {
  succeeded: unknown[];
  failed: { path: string; type: string; message: string }[];
};

type EnumResult = { ok: boolean; value?: unknown; error?: unknown };

test.describe("shim: fs_ops guardrails on a real filesystem", () => {
  let workspace = "";

  test.beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "metrists-fsops-"));
  });

  test.afterEach(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  const abs = (name: string): string => path.join(workspace, name);

  test("create_files materializes real empty files on disk", async () => {
    const target = abs("created.md");
    const { status, body } = await invoke("create_files", { paths: [target] });

    expect(status).toBe(200);
    expect((body as BatchResult).failed).toEqual([]);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("");
  });

  test("write_files persists content and read_files reads it back (both directions)", async () => {
    const target = abs("note.md");
    const content = "# Hello guardrails\n";

    const write = await invoke("write_files", {
      files: [{ path: target, content }],
    });
    expect(write.status).toBe(200);
    expect((write.body as BatchResult).failed).toEqual([]);

    // Ground truth: the bytes are on disk.
    await expect(fs.readFile(target, "utf8")).resolves.toBe(content);

    // App-reported: read_files returns the same content the disk holds.
    const read = await invoke("read_files", { paths: [target] });
    const succeeded = (read.body as BatchResult).succeeded as {
      path: string;
      content: string;
    }[];
    expect(succeeded[0]?.content).toBe(content);
  });

  test("write_files creates missing parent directories", async () => {
    const target = abs("deeply/nested/dir/file.md");
    const { body } = await invoke("write_files", {
      files: [{ path: target, content: "nested\n" }],
    });

    expect((body as BatchResult).failed).toEqual([]);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("nested\n");
  });

  test("move_file relocates content, leaving no source behind", async () => {
    const from = abs("source.md");
    const to = abs("moved/dest.md");
    await fs.writeFile(from, "movable\n", "utf8");

    const { status, body } = await invoke("move_file", {
      oldPath: from,
      newPath: to,
    });
    expect(status).toBe(200);
    expect((body as EnumResult).ok).toBe(true);

    await expect(fs.readFile(to, "utf8")).resolves.toBe("movable\n");
    await expect(fs.access(from)).rejects.toThrow();
  });

  test("copy_file duplicates content, leaving the source intact", async () => {
    const from = abs("original.md");
    const to = abs("copy.md");
    await fs.writeFile(from, "copyable\n", "utf8");

    const { body } = await invoke("copy_file", { from, to });
    expect((body as EnumResult).ok).toBe(true);

    await expect(fs.readFile(from, "utf8")).resolves.toBe("copyable\n");
    await expect(fs.readFile(to, "utf8")).resolves.toBe("copyable\n");
  });

  test("delete_files removes real files from disk", async () => {
    const target = abs("doomed.md");
    await fs.writeFile(target, "bye\n", "utf8");

    const { body } = await invoke("delete_files", { paths: [target] });
    expect((body as BatchResult).failed).toEqual([]);
    await expect(fs.access(target)).rejects.toThrow();
  });

  test("check_exists reports presence per path", async () => {
    const present = abs("present.md");
    const missing = abs("missing.md");
    await fs.writeFile(present, "here\n", "utf8");

    const { body } = await invoke("check_exists", {
      paths: [present, missing],
    });
    const results = body as { path: string; exists: boolean }[];
    expect(results.find((r) => r.path === present)?.exists).toBe(true);
    expect(results.find((r) => r.path === missing)?.exists).toBe(false);
  });

  test("get_metadata reports type and byte size of a real file", async () => {
    const target = abs("sized.md");
    const content = "hello\n"; // 6 bytes
    await fs.writeFile(target, content, "utf8");

    const { body } = await invoke("get_metadata", { paths: [target] });
    const meta = (body as BatchResult).succeeded as {
      path: string;
      type: string;
      size: number;
    }[];
    expect(meta[0]?.type).toBe("file");
    expect(meta[0]?.size).toBe(Buffer.byteLength(content));
  });

  test("read_directory lists children and hides dotfiles unless asked", async () => {
    await fs.writeFile(abs("visible.md"), "v\n", "utf8");
    await fs.writeFile(abs(".hidden"), "h\n", "utf8");
    await fs.mkdir(abs(".git"));

    const hiddenExcluded = await invoke("read_directory", {
      path: workspace,
      recursive: false,
      includeFiles: true,
      includeDirectories: true,
      includeHidden: false,
    });
    const excludedPaths = (hiddenExcluded.body as EnumResult).value as string[];
    expect(excludedPaths.some((p) => p.endsWith("visible.md"))).toBe(true);
    expect(excludedPaths.some((p) => p.endsWith(".hidden"))).toBe(false);
    expect(excludedPaths.some((p) => p.endsWith(".git"))).toBe(false);

    const hiddenIncluded = await invoke("read_directory", {
      path: workspace,
      recursive: false,
      includeFiles: true,
      includeDirectories: true,
      includeHidden: true,
    });
    const includedPaths = (hiddenIncluded.body as EnumResult).value as string[];
    expect(includedPaths.some((p) => p.endsWith(".hidden"))).toBe(true);
  });
});
