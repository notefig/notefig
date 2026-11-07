/**
 * The shared level end to end, in-process: two clones of one real bare
 * remote (`git http-backend`), each its own sync workspace in one core
 * (two devices), the real engine and worker API with the real markdown
 * merge as the worker's merge driver, files and documents over Node's fs,
 * live editors.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineModule, type Core } from "@notefig/core";
import { QueryClient } from "@tanstack/react-query";
import { createTestCore } from "@/testing/test-core";
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
  type SyncOverwriteRecord,
} from "@/modules/sync";
import type { MarkdownMerge } from "@/modules/sync/merge/merge";

const codec = createMarkdownCodec();
const editorFs: EditorFs = {
  searchContent: vi.fn(async () => []),
  exists: vi.fn(async () => []),
  writeBinaryFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
};

const NOTE = [
  "# Note",
  "",
  "First paragraph.",
  "",
  "Second paragraph.",
  "",
  "Third paragraph.",
  "",
  "Fourth paragraph.",
  "",
  "Fifth paragraph.",
  "",
].join("\n");

let remote: TestRemote | null = null;
const cores: Core[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const core of cores.splice(0)) await core.dispose();
  remote?.cleanup();
  remote = null;
});

const read = (path: string) => fsp.readFile(path, "utf8");

async function writeSyncJson(ws: string, deviceId: string) {
  await fsp.mkdir(join(ws, ".notefig"), { recursive: true });
  await fsp.writeFile(
    syncConfigPath(ws),
    serializeSyncConfig({ remote: remote!.url, branch: "main", deviceId }),
  );
}

/** Two devices, A and B, synced to one remote holding `note.md`. */
async function setup(options: { wrapMerge?: (merge: MarkdownMerge) => MarkdownMerge } = {}) {
  remote = await createTestRemote({ "note.md": NOTE });
  const fs = nodeFs();
  const filesByPath = new Map<string, WorkspaceFiles>();
  const editors = createEditors();
  const runtime = inProcessSyncRuntime(fs, remote, options);
  const core = createTestCore({
    modules: [
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
  const open = async (name: string) => {
    const ws = await remote!.clone(name);
    await writeSyncJson(ws, name);
    await core.workspace(ws).open();
    const sync = core.workspace(ws).sync;
    await sync.whenReady();
    await sync.syncNow();
    return { ws, sync, note: join(ws, "note.md") };
  };
  const a = await open("device-a");
  const b = await open("device-b");
  const overwritten: SyncOverwriteRecord[] = [];
  core.hooks.on("sync:overwritten", ({ record }) => void overwritten.push(record));
  /** A save in workspace `ws`, as the app announces it. */
  const save = async (path: string, text: string) => {
    await fsp.writeFile(path, text);
    core.hooks.emit("files:written", { paths: [path], source: "app" });
  };
  return { remote, core, runtime, editors, a, b, save, overwritten, fs };
}

/** Open `path` in a live editor whose saves land on disk after `delayMs`
 *  and are announced, like the app's autosave. */
function openEditor(
  core: Core,
  editors: ReturnType<typeof createEditors>,
  path: string,
  text: string,
  ws: string,
  delayMs = 0,
) {
  getOrCreateEditor(
    editors,
    path,
    { type: "markdown", content: codec.parse(text), basePath: ws },
    editorFs,
  );
  const editor = editors.markdownEditor(path)!;
  const docSync = getDocumentSync(path);
  docSync.ensureBaseline(text);
  docSync.writer = async (markdown) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    await fsp.writeFile(path, markdown);
    core.hooks.emit("files:written", { paths: [path], source: "app" });
  };
  /** Type `insert` at `pos` and hand the edit to the save pipeline. */
  const type = (pos: number, insert: string) => {
    editor.chain().insertContentAt(pos, insert).run();
    docSync.pushUpdate(() => editor.getJSON());
  };
  return { editor, docSync, type, close: () => disposeEditor(editors, path) };
}

/** The position just inside the start of top-level block `index`. */
function blockStart(editor: { state: { doc: { child(i: number): { nodeSize: number } } } }, index: number) {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
  return pos + 1;
}

const remoteNote = (r: TestRemote) => runGit(r.bare, ["show", "main:note.md"]);
const recoveryRefs = async (ws: string) =>
  (await runGit(ws, ["for-each-ref", "--format=%(refname)", "refs/notefig-local/recovery/"]))
    .split("\n")
    .filter(Boolean);

describe("shared sync: the rebase loop and the merge", () => {
  it("keeps both devices' edits to different blocks of one file", async () => {
    const { a, b, save, remote, overwritten } = await setup();
    await save(a.note, NOTE.replace("First paragraph.", "First paragraph, by A."));
    await save(b.note, NOTE.replace("Fourth paragraph.", "Fourth paragraph, by B."));
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();

    const both = NOTE.replace("First paragraph.", "First paragraph, by A.").replace(
      "Fourth paragraph.",
      "Fourth paragraph, by B.",
    );
    expect(await read(a.note)).toBe(both);
    expect(await read(b.note)).toBe(both);
    expect(await remoteNote(remote)).toBe(both.trimEnd());
    expect(overwritten).toEqual([]);
    expect(b.sync.capabilities()).toMatchObject({ status: "synced", merges: true });
    expect(b.sync.overwrites()).toEqual([]);
  });

  it("gives the same sentence to the side already on the branch, saving and flagging the other", async () => {
    const { a, b, save, remote, overwritten } = await setup();
    // Both replace the same word: an overlap, not two inserts.
    await save(a.note, NOTE.replace("Second paragraph.", "Second section by A."));
    await save(b.note, NOTE.replace("Second paragraph.", "Second chapter by B."));
    await a.sync.syncNow();
    await b.sync.syncNow();

    const won = NOTE.replace("Second paragraph.", "Second section by A.");
    expect(await read(b.note)).toBe(won);
    expect(await remoteNote(remote)).toBe(won.trimEnd());
    expect(overwritten).toHaveLength(1);
    expect(overwritten[0]).toMatchObject({ path: b.note, binary: false });
    expect(overwritten[0].fragments.join(" ")).toContain("chapter by B");
    expect(b.sync.overwrites()).toEqual(overwritten);

    // The local side is on a local-only recovery ref…
    const refs = await recoveryRefs(b.ws);
    expect(refs).toEqual([overwritten[0].recoveryRef]);
    expect(await runGit(b.ws, ["show", `${refs[0]}:note.md`])).toContain("Second chapter by B.");
    // …which never reaches the remote.
    await b.sync.syncNow();
    expect(await runGit(remote.bare, ["for-each-ref", "refs/notefig-local/"])).toBe("");
    expect(await runGit(remote.bare, ["for-each-ref", "--format=%(refname)"])).toBe("refs/heads/main");

    b.sync.dismissOverwrite(overwritten[0].id);
    expect(b.sync.overwrites()).toEqual([]);
  });

  it("lets the remote win files that aren't markdown, keeping ours on the recovery ref", async () => {
    const { a, b, core, remote, overwritten } = await setup();
    const write = async (ws: string, files: Record<string, string>) => {
      for (const [name, text] of Object.entries(files)) await fsp.writeFile(join(ws, name), text);
      core.hooks.emit("files:written", { paths: Object.keys(files).map((name) => join(ws, name)), source: "app" });
    };
    await write(a.ws, { "data.json": '{"by":"A"}\n', "img.bin": "A\u0000bytes" });
    await a.sync.syncNow();
    await b.sync.syncNow();
    await write(a.ws, { "data.json": '{"by":"A2"}\n', "img.bin": "A2\u0000bytes" });
    await write(b.ws, { "data.json": '{"by":"B"}\n', "img.bin": "B\u0000bytes" });
    await a.sync.syncNow();
    await b.sync.syncNow();

    expect(await read(join(b.ws, "data.json"))).toBe('{"by":"A2"}\n');
    expect(await read(join(b.ws, "img.bin"))).toBe("A2\u0000bytes");
    expect(overwritten.map((record) => [record.path, record.binary])).toEqual([
      [join(b.ws, "data.json"), false],
      [join(b.ws, "img.bin"), true],
    ]);
    const ref = overwritten[0].recoveryRef!;
    expect(await runGit(b.ws, ["show", `${ref}:data.json`])).toBe('{"by":"B"}');
    expect(await runGit(b.ws, ["show", `${ref}:img.bin`])).toContain("B");
    expect(await runGit(remote.bare, ["for-each-ref", "refs/notefig-local/"])).toBe("");
  });

  it("fetches, merges and retries when someone else's push lands first", async () => {
    const { b, save, remote, runtime } = await setup();
    const plain = await remote.clone("plain");
    await save(b.note, NOTE.replace("Fifth paragraph.", "Fifth paragraph, by B."));
    let raced = false;
    remote.onRequest = async (label) => {
      if (raced || label !== "POST git-receive-pack") return;
      raced = true;
      // Lands between B's poll and B's push: B's compare-and-swap fails.
      await remote.pushFromPlainGit(
        plain,
        { "note.md": NOTE.replace("First paragraph.", "First paragraph, from the CLI.") },
        "cli",
      );
    };
    await b.sync.syncNow();
    remote.onRequest = null;

    const both = NOTE.replace("First paragraph.", "First paragraph, from the CLI.").replace(
      "Fifth paragraph.",
      "Fifth paragraph, by B.",
    );
    expect(raced).toBe(true);
    expect(runtime.calls.filter((call) => call === "push").length).toBeGreaterThanOrEqual(2);
    expect(await remoteNote(remote)).toBe(both.trimEnd());
    expect(await read(b.note)).toBe(both);
    expect(b.sync.capabilities().status).toBe("synced");
  });

  it("merges into an open editor with unsaved edits without losing them or moving the caret", async () => {
    const { core, editors, a, b, save, remote } = await setup();
    await save(a.note, NOTE.replace("Fourth paragraph.", "Fourth paragraph, by A."));
    await a.sync.syncNow();

    // B types in its editor; the save is still on its way to disk.
    const view = openEditor(core, editors, b.note, NOTE, b.ws, 150);
    const at = blockStart(view.editor, 1) + "First".length;
    view.type(at, " typed");
    view.editor.commands.setTextSelection(at + " typed".length);
    const caretText = () => {
      const { from } = view.editor.state.selection;
      return view.editor.state.doc.textBetween(from - 6, from);
    };
    expect(caretText()).toBe(" typed");

    await b.sync.syncNow();

    const live = codec.serialize(view.editor.getJSON());
    expect(live).toContain("First typed paragraph.");
    expect(live).toContain("Fourth paragraph, by A.");
    expect(caretText()).toBe(" typed");
    await vi.waitFor(async () => expect(await read(b.note)).toContain("First typed paragraph."));
    expect(await read(b.note)).toContain("Fourth paragraph, by A.");

    await b.sync.syncNow();
    const pushed = await remoteNote(remote);
    expect(pushed).toContain("First typed paragraph.");
    expect(pushed).toContain("Fourth paragraph, by A.");
    view.close();
  });

  it("keeps a collaborator's edit out of the undo history", async () => {
    const { core, editors, a, b, save } = await setup();
    const view = openEditor(core, editors, b.note, NOTE, b.ws);
    await save(a.note, NOTE.replace("Third paragraph.", "Third paragraph, by A."));
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(codec.serialize(view.editor.getJSON())).toContain("Third paragraph, by A.");

    view.editor.chain().insertContentAt(blockStart(view.editor, 1), "Mine. ").run();
    expect(codec.serialize(view.editor.getJSON())).toContain("Mine. First paragraph.");
    view.editor.commands.undo();
    view.editor.commands.undo();
    const live = codec.serialize(view.editor.getJSON());
    expect(live).not.toContain("Mine.");
    expect(live).toContain("Third paragraph, by A.");
    view.close();
  });
});

describe("shared level", () => {
  it("moves solo ↔ shared on the presence input, with a fast poll and coalesced commits", async () => {
    const { a, runtime, save } = await setup();
    expect(a.sync.capabilities()).toMatchObject({ merges: false, commitMaxWaitMs: null });
    a.sync.setPeersPresent(true);
    expect(a.sync.capabilities()).toMatchObject({
      merges: true,
      leases: true,
      pollIntervalMs: 1_500,
      commitMaxWaitMs: 3_000,
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const commits = () => runtime.calls.filter((call) => call === "commit").length;
    const before = commits();
    // A save every half second, never pausing: shared still commits.
    for (let i = 0; i < 8; i++) {
      await save(a.note, NOTE.replace("First paragraph.", `First paragraph ${i}.`));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(commits()).toBeGreaterThan(before);
    vi.useRealTimers();

    a.sync.setPeersPresent(false);
    expect(a.sync.capabilities()).toMatchObject({ merges: false, pollIntervalMs: 12_000 });
  });

  it("commits only after a pause at solo, however long the typing goes on", async () => {
    const { a, runtime, save } = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const commits = () => runtime.calls.filter((call) => call === "commit").length;
    const before = commits();
    for (let i = 0; i < 8; i++) {
      await save(a.note, NOTE.replace("First paragraph.", `First paragraph ${i}.`));
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(commits()).toBe(before);
    vi.useRealTimers();
  });
});

describe("failsafe", () => {
  it("stops on a rewritten remote branch, after saving local state; accepting incoming resets", async () => {
    const { a, core, remote } = await setup();
    const stops: unknown[] = [];
    core.hooks.on("sync:failsafe", (event) => void stops.push(event));
    const plain = await remote.clone("plain");
    await runGit(plain, ["checkout", "-q", "--orphan", "rewritten"]);
    await fsp.writeFile(join(plain, "note.md"), "# Rewritten\n\nAll new history.\n");
    await runGit(plain, ["add", "-A"]);
    await runGit(plain, ["commit", "-q", "-m", "rewrite"]);
    await runGit(plain, ["push", "-q", "--force", "origin", "rewritten:main"]);

    await fsp.writeFile(a.note, NOTE.replace("First paragraph.", "First paragraph, local."));
    core.hooks.emit("files:written", { paths: [a.note], source: "app" });
    await a.sync.syncNow();

    expect(a.sync.capabilities()).toMatchObject({
      status: "failsafe",
      commits: false,
      canResume: false,
      failsafe: { reason: "unrelated" },
    });
    const refs = await recoveryRefs(a.ws);
    expect(refs).toEqual([a.sync.capabilities().failsafe!.recoveryRef]);
    expect(await runGit(a.ws, ["show", `${refs[0]}:note.md`])).toContain("First paragraph, local.");
    expect(stops).toEqual([expect.objectContaining({ workspacePath: a.ws, reason: "unrelated" })]);

    await a.sync.acceptIncoming();
    expect(a.sync.capabilities()).toMatchObject({ status: "synced", failsafe: null });
    expect(await read(a.note)).toBe("# Rewritten\n\nAll new history.\n");
    expect(await runGit(a.ws, ["rev-parse", "HEAD"])).toBe(await remote.tip());
    expect(await runGit(a.ws, ["status", "--porcelain"])).toBe("");
    // Both choices leave the local state recoverable.
    expect((await recoveryRefs(a.ws)).length).toBeGreaterThanOrEqual(1);
    expect(await runGit(remote.bare, ["for-each-ref", "refs/notefig-local/"])).toBe("");
  });

  it("turning sync off from the failsafe keeps the local files and the recovery ref", async () => {
    const { a, core, remote } = await setup();
    const plain = await remote.clone("plain");
    await runGit(plain, ["checkout", "-q", "--orphan", "rewritten"]);
    await fsp.writeFile(join(plain, "note.md"), "Rewritten.\n");
    await runGit(plain, ["add", "-A"]);
    await runGit(plain, ["commit", "-q", "-m", "rewrite"]);
    await runGit(plain, ["push", "-q", "--force", "origin", "rewritten:main"]);
    const local = NOTE.replace("First paragraph.", "First paragraph, kept.");
    await fsp.writeFile(a.note, local);
    core.hooks.emit("files:written", { paths: [a.note], source: "app" });
    await a.sync.syncNow();
    expect(a.sync.capabilities().status).toBe("failsafe");

    await a.sync.disable();
    expect(a.sync.capabilities().active).toBe(false);
    await expect(fsp.stat(syncConfigPath(a.ws))).rejects.toThrow();
    expect(await read(a.note)).toBe(local);
    expect(await recoveryRefs(a.ws)).toHaveLength(1);
  });

  it("stops when a merge fails validation", async () => {
    const { a, b, save } = await setup({
      wrapMerge: () => () => ({ failed: "unstable: a merged block doesn't round-trip" }),
    });
    await save(a.note, NOTE.replace("First paragraph.", "First paragraph, by A."));
    await save(b.note, NOTE.replace("Fifth paragraph.", "Fifth paragraph, by B."));
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.sync.capabilities()).toMatchObject({
      status: "failsafe",
      failsafe: { reason: "validation", paths: ["note.md"] },
    });
    expect(await recoveryRefs(b.ws)).toHaveLength(1);
    expect(await read(b.note)).toBe(NOTE.replace("Fifth paragraph.", "Fifth paragraph, by B."));
  });

  const rewriteAll = (who: string) =>
    ["First", "Second", "Third", "Fourth"].reduce(
      (text, word) => text.replace(`${word} paragraph.`, `${word} version-${who}.`),
      NOTE,
    );

  it("stops when edits made offline collide with too much of what changed meanwhile", async () => {
    const { a, b, save, remote } = await setup();
    remote.mode = "offline";
    await save(a.note, rewriteAll("A"));
    await a.sync.syncNow();
    expect(a.sync.capabilities().status).toBe("offline");
    remote.mode = "ok";
    await save(b.note, rewriteAll("B"));
    await b.sync.syncNow();

    await a.sync.syncNow();
    expect(a.sync.capabilities()).toMatchObject({
      status: "failsafe",
      failsafe: { reason: "divergence" },
    });
    expect(await read(a.note)).toBe(rewriteAll("A"));
    expect(await recoveryRefs(a.ws)).toHaveLength(1);
  });

  it("merges the same collisions made online: ordinary overlaps never trigger it", async () => {
    const { a, b, save, overwritten } = await setup();
    await save(a.note, rewriteAll("A"));
    await save(b.note, rewriteAll("B"));
    await b.sync.syncNow();
    await a.sync.syncNow();
    expect(a.sync.capabilities()).toMatchObject({ status: "synced", failsafe: null });
    expect(await read(a.note)).toBe(rewriteAll("B"));
    expect(overwritten).toHaveLength(1);
    expect(overwritten[0].fragments.join(" ")).toContain("version-A");
  });
});
