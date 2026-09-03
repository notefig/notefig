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

/** Raw-body invoke, mirroring the frontend transport's `?raw=1` path. */
async function invokeRaw(
  cmd: string,
  data: Uint8Array,
  headers?: Record<string, string>,
): Promise<{ status: number; bytes: Uint8Array | null; body: unknown }> {
  const query = `?raw=1${
    headers ? `&headers=${encodeURIComponent(JSON.stringify(headers))}` : ""
  }`;
  const res = await fetch(`${SHIM_URL}/invoke/${cmd}${query}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: new Uint8Array(data),
  });
  if (res.headers.get("content-type") === "application/octet-stream") {
    return {
      status: res.status,
      bytes: new Uint8Array(await res.arrayBuffer()),
      body: null,
    };
  }
  const text = await res.text();
  return { status: res.status, bytes: null, body: text ? JSON.parse(text) : null };
}

test.describe("shim: fs_ops guardrails on a real filesystem", () => {
  let workspace = "";

  test.beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "notefig-fsops-"));
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

  test("write_file persists content and read_file reads it back (both directions)", async () => {
    const target = abs("note.md");
    const content = "# Hello guardrails — déjà\n";

    const write = await invokeRaw(
      "write_file",
      new TextEncoder().encode(content),
      { "x-notefig-path": encodeURIComponent(target) },
    );
    expect(write.status).toBe(200);

    // Ground truth: the bytes are on disk.
    await expect(fs.readFile(target, "utf8")).resolves.toBe(content);

    // App-reported: read_file answers with the raw UTF-8 bytes.
    const read = await fetch(`${SHIM_URL}/invoke/read_file`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ path: target }),
    });
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("application/octet-stream");
    expect(new TextDecoder().decode(await read.arrayBuffer())).toBe(content);
  });

  test("write_file creates missing parent directories", async () => {
    const target = abs("deeply/nested/dir/file.md");
    const { status } = await invokeRaw(
      "write_file",
      new TextEncoder().encode("nested\n"),
      { "x-notefig-path": encodeURIComponent(target) },
    );

    expect(status).toBe(200);
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
    const excluded = (hiddenExcluded.body as EnumResult).value as {
      path: string;
      type: "file" | "directory";
    }[];
    expect(excluded.some((e) => e.path.endsWith("visible.md"))).toBe(true);
    expect(
      excluded.find((e) => e.path.endsWith("visible.md"))?.type,
    ).toBe("file");
    expect(excluded.some((e) => e.path.endsWith(".hidden"))).toBe(false);
    expect(excluded.some((e) => e.path.endsWith(".git"))).toBe(false);

    const hiddenIncluded = await invoke("read_directory", {
      path: workspace,
      recursive: false,
      includeFiles: true,
      includeDirectories: true,
      includeHidden: true,
    });
    const included = (hiddenIncluded.body as EnumResult).value as {
      path: string;
      type: "file" | "directory";
    }[];
    expect(included.some((e) => e.path.endsWith(".hidden"))).toBe(true);
    expect(included.find((e) => e.path.endsWith(".git"))?.type).toBe(
      "directory",
    );
  });

  test("write_binary_file + read_binary_file round-trip raw bytes", async () => {
    // Unicode path exercises the percent-encoded header; a 0x00 byte and a
    // high byte prove nothing JSON-ish mangles the payload.
    const target = abs("déjà vu.bin");
    const payload = new Uint8Array([0, 1, 2, 127, 128, 255]);

    const write = await invokeRaw("write_binary_file", payload, {
      "x-notefig-path": encodeURIComponent(target),
    });
    expect(write.status).toBe(200);
    // Ground truth: the exact bytes landed on disk.
    expect(new Uint8Array(await fs.readFile(target))).toEqual(payload);

    // read_binary_file answers with a raw octet-stream body.
    const rawRead = await fetch(
      `${SHIM_URL}/invoke/read_binary_file`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ path: target }),
      },
    );
    expect(rawRead.status).toBe(200);
    expect(rawRead.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(new Uint8Array(await rawRead.arrayBuffer())).toEqual(payload);
  });

  test("read_binary_file rejects a missing path with the typed error", async () => {
    const missing = abs("missing.bin");
    const res = await invoke("read_binary_file", { path: missing });
    expect(res.status).toBe(422);
    const error = res.body as { path: string; type: string };
    expect(error.type).toBe("not_found");
    expect(error.path).toBe(missing);
  });
});
