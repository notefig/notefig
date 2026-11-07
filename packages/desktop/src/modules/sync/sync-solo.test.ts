/**
 * Solo sync end to end, in-process: a real bare remote (`git http-backend`),
 * real clones on disk, the real engine and the real worker API (served
 * in-process), files and documents over Node's fs, a live editor.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineModule, type Core } from "@notefig/core";
import { createTestCore } from "@/testing/test-core";
import { QueryClient } from "@tanstack/react-query";
import {
  createTestRemote,
  inProcessSyncRuntime,
  nodeFs,
  runGit,
  type TestRemote,
} from "@/testing/test-sync";
import { createDocuments } from "@/modules/documents";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/modules/files";
import { createEditors } from "@/modules/editors";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import {
  disposeEditor,
  getOrCreateEditor,
  type EditorFs,
} from "@/components/editor/editor-store";
import { getDocumentSync } from "@/utils/markdown-conversion";
import {
  serializeSyncConfig,
  syncConfigPath,
  syncModule,
  type SyncIncomingContent,
} from "@/modules/sync";

const codec = createMarkdownCodec();
const editorFs: EditorFs = {
  searchContent: vi.fn(async () => []),
  exists: vi.fn(async () => []),
  writeBinaryFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
};

let remote: TestRemote | null = null;
const cores: Core[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const core of cores.splice(0)) await core.dispose();
  remote?.cleanup();
  remote = null;
});

async function writeSyncJson(ws: string, deviceId: string) {
  await fsp.mkdir(join(ws, ".notefig"), { recursive: true });
  await fsp.writeFile(
    syncConfigPath(ws),
    serializeSyncConfig({ remote: remote!.url, branch: "main", deviceId }),
  );
}

async function setup(options: { syncJson?: boolean } = {}) {
  remote = await createTestRemote();
  const ws = await remote.clone("device-a");
  if (options.syncJson !== false) await writeSyncJson(ws, "device-a");
  const fs = nodeFs();
  const filesByPath = new Map<string, WorkspaceFiles>();
  const editors = createEditors();
  const runtime = inProcessSyncRuntime(fs, remote);
  const core = createTestCore({
    modules: [
      // The real files, announcing on core's hooks.
      defineModule({
        name: "files",
        workspace: {
          create: (ctx) => {
            const files = createWorkspaceFiles({
              workspacePath: ctx.workspace.path,
              fs,
              queryClient: new QueryClient(),
              hooks: ctx.hooks,
            });
            filesByPath.set(ctx.workspace.path, files);
            return files;
          },
          dispose: (instance) => instance.dispose(),
        },
      }),
      defineModule({
        name: "documents",
        register: (ctx) =>
          createDocuments({
            fs,
            openFiles: () => [...filesByPath.values()],
            editors,
            hooks: ctx.hooks,
          }),
      }),
      runtime.module,
      syncModule,
    ],
    platform: { fs },
  });
  cores.push(core);
  await core.boot();
  await core.workspace(ws).open();
  const sync = core.workspace(ws).sync;
  await sync.whenReady();
  // The start's first cycle.
  await sync.syncNow();
  const files = filesByPath.get(ws)!;
  return { remote, ws, fs, files, editors, runtime, core, sync };
}

const read = (path: string) => fsp.readFile(path, "utf8");

describe("solo sync", () => {
  it("starts synced: nothing to commit, the remote already has everything", async () => {
    const { sync, remote, runtime } = await setup();

    expect(sync.capabilities()).toMatchObject({ active: true, status: "synced", leases: false });
    expect(runtime.launched).toBe(1);
    expect(runtime.calls.slice(0, 3)).toEqual(["open", "commit", "poll"]);
    expect(runtime.calls).not.toContain("push");
    expect(await remote.tip()).toBe(await runGit(join(remote.root, "device-a"), ["rev-parse", "HEAD"]));
  });

  it("commits a save once typing pauses and pushes it, nothing per keystroke", async () => {
    const { sync, files, remote, ws, core, runtime } = await setup();
    const committed = vi.fn();
    const pushed = vi.fn();
    core.hooks.on("sync:committed", committed);
    core.hooks.on("sync:pushed", pushed);
    const before = await remote.tip();
    const callsBefore = runtime.calls.length;

    await files.collections.content.preload();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await files.file(join(ws, "note.md")).write("# Note\n\nEdited on device A.\n");
    await files.file(join(ws, "note.md")).write("# Note\n\nEdited on device A again.\n");
    // Within the pause, no git work at all.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.calls.length).toBe(callsBefore);
    await vi.advanceTimersByTimeAsync(4_000);
    vi.useRealTimers();
    await sync.syncNow();

    await vi.waitFor(async () => expect(await remote.tip()).not.toBe(before));
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed.mock.calls[0][0].paths).toEqual(["note.md"]);
    expect(pushed).toHaveBeenCalledTimes(1);
    const log = await runGit(remote.bare, ["log", "-1", "--format=%an <%ae>|%s"]);
    // Decision 11: the repo's identity, and the message format.
    expect(log).toBe("User device-a <device-a@test.local>|notefig: User device-a edited note.md");
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe(
      "# Note\n\nEdited on device A again.",
    );
    expect(sync.capabilities().status).toBe("synced");
  });

  it("never commits .notefig/ or files git ignores", async () => {
    const { sync, remote, ws, core } = await setup();
    await fsp.writeFile(join(ws, ".gitignore"), "*.tmp\n");
    await fsp.writeFile(join(ws, "scratch.tmp"), "ignored");
    await fsp.mkdir(join(ws, ".notefig", "scratchpads"), { recursive: true });
    await fsp.writeFile(join(ws, ".notefig", "scratchpads", "pad.md"), "mine");
    core.hooks.emit("files:written", {
      paths: [join(ws, ".gitignore"), join(ws, "scratch.tmp"), join(ws, ".notefig", "scratchpads", "pad.md")],
      source: "app",
    });
    await sync.syncNow();

    const tree = await runGit(remote.bare, ["ls-tree", "-r", "--name-only", "main"]);
    expect(tree.split("\n").sort()).toEqual([".gitignore", "note.md"]);
  });

  it("brings a plain-git push into an open editor, keeping the caret", async () => {
    const { sync, remote, ws, editors, core } = await setup();
    const path = join(ws, "note.md");
    getOrCreateEditor(
      editors,
      path,
      { type: "markdown", content: codec.parse(await read(path)), basePath: ws },
      editorFs,
    );
    const editor = editors.markdownEditor(path)!;
    getDocumentSync(path).ensureBaseline(await read(path));
    // Caret inside "First paragraph."
    const firstParagraph = editor.state.doc.child(1);
    const caret = editor.state.doc.child(0).nodeSize + 1 + 5;
    editor.commands.setTextSelection(caret);
    const channel = sync.document(path);
    const incoming: SyncIncomingContent[] = [];
    void (async () => {
      for await (const event of channel.incoming) incoming.push(event);
    })();
    const applied = vi.fn();
    core.hooks.on("sync:remote-applied", applied);

    const plain = await remote.clone("plain");
    const pushed = await remote.pushFromPlainGit(
      plain,
      {
        "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, edited elsewhere.\n",
        "docs/new.md": "A new file.\n",
      },
      "edit from the CLI",
    );
    await sync.syncNow();

    expect(await read(path)).toContain("edited elsewhere");
    expect(await read(join(ws, "docs", "new.md"))).toBe("A new file.\n");
    const live = codec.serialize(editor.getJSON());
    expect(live).toContain("Second paragraph, edited elsewhere.");
    expect(editor.state.doc.child(1).textContent).toBe(firstParagraph.textContent);
    expect(editor.state.selection.from).toBe(caret);
    expect(applied).toHaveBeenCalledWith(
      expect.objectContaining({ commit: pushed, paths: expect.arrayContaining([path]) }),
    );
    await vi.waitFor(() =>
      expect(incoming).toEqual([
        expect.objectContaining({ kind: "applied", commit: pushed, adopted: true }),
      ]),
    );
    expect(await runGit(ws, ["rev-parse", "HEAD"])).toBe(pushed);
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
    channel.close();
    disposeEditor(editors, path);
  });

  it("replays local commits onto remote ones that touch other files, then pushes", async () => {
    const { sync, remote, ws, core } = await setup();
    remote.mode = "offline";
    await fsp.writeFile(join(ws, "mine.md"), "Written offline.\n");
    core.hooks.emit("files:written", { paths: [join(ws, "mine.md")], source: "app" });
    await sync.syncNow();
    expect(sync.capabilities().status).toBe("offline");

    remote.mode = "ok";
    const plain = await remote.clone("plain");
    await remote.pushFromPlainGit(plain, { "theirs.md": "From the CLI.\n" }, "cli");
    await sync.syncNow();

    expect(sync.capabilities().status).toBe("synced");
    const tree = await runGit(remote.bare, ["ls-tree", "-r", "--name-only", "main"]);
    expect(tree.split("\n").sort()).toEqual(["mine.md", "note.md", "theirs.md"]);
    expect(await read(join(ws, "theirs.md"))).toBe("From the CLI.\n");
  });

  it("stops at diverged when both sides changed the same file, writing no markers", async () => {
    const { sync, remote, ws, core } = await setup();
    const path = join(ws, "note.md");
    remote.mode = "offline";
    await fsp.writeFile(path, "# Note\n\nMine.\n");
    core.hooks.emit("files:written", { paths: [path], source: "app" });
    await sync.syncNow();

    remote.mode = "ok";
    const plain = await remote.clone("plain");
    const theirs = await remote.pushFromPlainGit(plain, { "note.md": "# Note\n\nTheirs.\n" }, "cli");
    await sync.syncNow();

    expect(sync.capabilities()).toMatchObject({
      status: "diverged",
      commits: false,
      canResume: true,
    });
    expect(sync.capabilities().detail).toContain("note.md");
    expect(await read(path)).toBe("# Note\n\nMine.\n");
    expect(await remote.tip()).toBe(theirs);
  });

  it("holds remote content back from an editor with unsaved edits and stops", async () => {
    const { sync, remote, ws, editors } = await setup();
    const path = join(ws, "note.md");
    getOrCreateEditor(
      editors,
      path,
      { type: "markdown", content: codec.parse(await read(path)), basePath: ws },
      editorFs,
    );
    const editor = editors.markdownEditor(path)!;
    const docSync = getDocumentSync(path);
    docSync.ensureBaseline(await read(path));
    // A save that never finishes: the edit is not on disk yet.
    docSync.writer = () => new Promise<void>(() => {});
    docSync.pushUpdate(() => editor.getJSON());

    const plain = await remote.clone("plain");
    await remote.pushFromPlainGit(plain, { "note.md": "# Note\n\nTheirs.\n" }, "cli");
    await sync.syncNow();

    expect(sync.capabilities().status).toBe("diverged");
    expect(await read(path)).not.toContain("Theirs.");
    expect(codec.serialize(editor.getJSON())).not.toContain("Theirs.");
    disposeEditor(editors, path);
  });

  it("shows an auth error and stops until resumed", async () => {
    const { sync, remote, ws, core, runtime } = await setup();
    remote.mode = "unauthorized";
    await fsp.writeFile(join(ws, "note.md"), "changed\n");
    core.hooks.emit("files:written", { paths: [join(ws, "note.md")], source: "app" });
    await sync.syncNow();

    expect(sync.capabilities()).toMatchObject({ status: "auth-error", polls: false, canResume: true });
    const calls = runtime.calls.length;
    await sync.syncNow();
    expect(runtime.calls.length).toBe(calls);

    remote.mode = "ok";
    sync.resume();
    await sync.syncNow();
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("changed");
    expect(sync.capabilities().status).toBe("synced");
  });

  it("goes offline, keeps the commit, and recovers on the next cycle", async () => {
    const { sync, remote, ws, core } = await setup();
    remote.mode = "offline";
    await fsp.writeFile(join(ws, "note.md"), "offline edit\n");
    core.hooks.emit("files:written", { paths: [join(ws, "note.md")], source: "app" });
    await sync.syncNow();
    expect(sync.capabilities().status).toBe("offline");
    expect(await runGit(ws, ["log", "-1", "--format=%s"])).toBe(
      "notefig: User device-a edited note.md",
    );

    remote.mode = "ok";
    await sync.syncNow();
    expect(sync.capabilities().status).toBe("synced");
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("offline edit");
  });

  it("re-polls after a push with no answer instead of pushing again blindly", async () => {
    const { sync, remote, ws, core } = await setup();
    remote.mode = "hang-push";
    await fsp.writeFile(join(ws, "note.md"), "maybe landed\n");
    core.hooks.emit("files:written", { paths: [join(ws, "note.md")], source: "app" });
    await sync.syncNow();
    // It did land: the next poll sees the remote at our head, nothing to push.
    remote.mode = "ok";
    const pushesBefore = remote.requests.filter((r) => r === "POST git-receive-pack").length;
    await sync.syncNow();
    expect(remote.requests.filter((r) => r === "POST git-receive-pack").length).toBe(pushesBefore);
    expect(await remote.tip()).toBe(await runGit(ws, ["rev-parse", "HEAD"]));
    expect(sync.capabilities().status).toBe("synced");
  });

  it("dispose stops the worker, the timers and the listeners", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { core, runtime, ws } = await setup();
    await core.dispose();
    cores.splice(0);
    expect(runtime.terminated).toBe(runtime.launched);
    const calls = runtime.calls.length;

    core.hooks.emit("files:written", { paths: [join(ws, "note.md")], source: "app" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.calls.length).toBe(calls);
  });

  it("turns on in a regular clone: checks access, writes sync.json, pushes local changes", async () => {
    const { sync, remote, ws, runtime } = await setup({ syncJson: false });
    expect(sync.capabilities().active).toBe(false);
    expect(runtime.launched).toBe(0);
    await fsp.writeFile(join(ws, "local.md"), "Before sync was on.\n");

    const verified = await sync.verify({ remote: remote.url, branch: "main" });
    expect(verified).toEqual({
      ok: true,
      value: { remoteHead: await remote.tip(), canPush: true },
    });
    expect(runtime.terminated).toBe(1);

    await sync.enable({ remote: remote.url, branch: "main" });
    await sync.syncNow();

    const config = JSON.parse(await read(syncConfigPath(ws)));
    expect(config).toMatchObject({ remote: remote.url, branch: "main" });
    expect(config.deviceId).toMatch(/[0-9a-f-]{36}/);
    expect(await runGit(remote.bare, ["show", "main:local.md"])).toBe("Before sync was on.");
    expect(await read(join(ws, ".git", "info", "exclude"))).toContain(".notefig/");

    await sync.disable();
    expect(sync.capabilities().active).toBe(false);
    await expect(fsp.stat(syncConfigPath(ws))).rejects.toThrow();
  });

  it("treats two clones open in one app as two devices", async () => {
    const { sync: a, remote, ws: wsA, core } = await setup();
    const wsB = await remote.clone("device-b");
    await writeSyncJson(wsB, "device-b");
    await core.workspace(wsB).open();
    const b = core.workspace(wsB).sync;
    await b.whenReady();
    await b.syncNow();
    expect(b.config()?.deviceId).toBe("device-b");
    expect(a.config()?.deviceId).toBe("device-a");

    await fsp.writeFile(join(wsA, "from-a.md"), "Hello from A.\n");
    core.hooks.emit("files:written", { paths: [join(wsA, "from-a.md")], source: "app" });
    await a.syncNow();
    await b.syncNow();

    expect(await read(join(wsB, "from-a.md"))).toBe("Hello from A.\n");
    // A write in A's workspace is not B's to commit.
    expect(await runGit(wsB, ["log", "-1", "--format=%an"])).toBe("User device-a");
    expect(b.capabilities().status).toBe("synced");
  });

  it("reports missing access when checking a remote without a stored token", async () => {
    const { sync, remote } = await setup({ syncJson: false });
    const verified = await sync.verify({ remote: "https://127.0.0.1/other.git", branch: "main" });
    expect(verified.ok).toBe(false);
    if (!verified.ok) expect(verified.error.code).toBe("AuthRequired");
    remote.mode = "ok";
  });
});
