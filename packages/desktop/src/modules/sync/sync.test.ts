/**
 * Sync end to end, in-process: a real bare remote (`git http-backend`),
 * real clones on disk, the real module and engine, `@notefig/git` run
 * in-process where the app runs it in the git worker, files and documents
 * over Node's fs, and a live editor where one matters.
 */
import { promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { defineModule, type Core } from "@notefig/core";
import { createTestCore } from "@/testing/test-core";
import { createTestRemote, inProcessGitWorker, nodeFs, runGit, type TestRemote } from "@/testing/test-sync";
import { createDocuments } from "@/modules/documents";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/modules/files";
import { createEditors } from "@/modules/editors";
import { projectSettingsModule } from "@/modules/project-settings";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { disposeEditor, getOrCreateEditor, type EditorFs } from "@/components/editor/editor-store";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { IDLE_COMMIT_MS, POLL_MS, pollInterval, SHARED_POLL_MS, syncModule } from "@/modules/sync";
import { OFFLINE_RETURN_MS } from "./sync-engine";
import { caretDecorations, docUnits, holdDecorations, touchesHeld } from "./sync-editor";
import { changedKeys, revertUnits, unitKeys, unitTexts } from "./sync-claims";
import { EditorState } from "@tiptap/pm/state";

// Each test runs many git http-backend processes.
vi.setConfig({ testTimeout: 30_000 });

const codec = createMarkdownCodec();
const editorFs: EditorFs = {
  searchContent: vi.fn(async () => []),
  exists: vi.fn(async () => []),
  writeBinaryFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
};
const createEditorDoc = (markdown: string) => {
  const editors = createEditors();
  const path = `/doc-${Math.random()}.md`;
  getOrCreateEditor(editors, path, { type: "markdown", content: codec.parse(markdown), basePath: "/" }, editorFs);
  const doc = editors.markdownEditor(path)!.state.doc;
  disposeEditor(editors, path);
  return doc;
};
const SYNCED = { "metrists.json": '{\n  "sync": {\n    "enabled": true\n  }\n}\n' };
const SEED = { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph.\n" };

let remote: TestRemote | null = null;
const cores: Core[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const core of cores.splice(0)) await core.dispose();
  remote?.cleanup();
  remote = null;
});

async function writeDevice(ws: string, device: { on: boolean; lastSyncedAt?: number }) {
  await fsp.mkdir(join(ws, ".notefig"), { recursive: true });
  await fsp.writeFile(join(ws, ".notefig", "sync.json"), JSON.stringify({ deviceId: basename(ws), ...device }));
}

/** A clone open in a core. `synced`: the project syncs and this device
 *  said yes (the default); `asked`: the project syncs, no answer yet;
 *  `plain`: the project doesn't sync. */
async function setup(mode: "synced" | "asked" | "plain" = "synced") {
  remote = await createTestRemote(mode === "plain" ? SEED : { ...SEED, ...SYNCED });
  const ws = await remote.clone("device-a");
  if (mode === "synced") await writeDevice(ws, { on: true });
  const fs = nodeFs();
  const filesByPath = new Map<string, WorkspaceFiles>();
  const editors = createEditors();
  const gitWorker = inProcessGitWorker(fs, remote.http);
  const created = vi.spyOn(gitWorker, "register");
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
          createDocuments({ fs, openFiles: () => [...filesByPath.values()], editors, hooks: ctx.hooks }),
      }),
      gitWorker,
      projectSettingsModule,
      syncModule,
    ],
    platform: { fs, gitHttp: { supported: true, request: remote.http.request } },
  });
  cores.push(core);
  await core.boot();
  const open = async (path: string) => {
    await core.workspace(path).open();
    const sync = core.workspace(path).sync;
    await sync.whenReady();
    await sync.syncNow();
    return sync;
  };
  const sync = await open(ws);
  return { remote, ws, fs, files: filesByPath.get(ws)!, editors, core, sync, open, created };
}

const read = (path: string) => fsp.readFile(path, "utf8");
const tree = async (bare: string) => (await runGit(bare, ["ls-tree", "-r", "--name-only", "main"])).split("\n").sort();
const written = (core: Core, ...paths: string[]) => core.hooks.emit("files:written", { paths, source: "app" });

describe("sync: a project's setting, each device's answer", () => {
  it("costs nothing in a project that doesn't sync until asked", async () => {
    const { sync, remote } = await setup("plain");
    expect(sync.state()).toMatchObject({ setup: "off", remote: null });
    expect(remote.requests).toEqual([]);

    await sync.inspect();
    expect(sync.state()).toMatchObject({ setup: "off", remote: { url: remote.url, branch: "main" } });
  });

  it("turns on for everyone: checks push access, commits the setting with local work", async () => {
    const { sync, remote, ws } = await setup("plain");
    await fsp.writeFile(join(ws, "local.md"), "Before sync was on.\n");

    await sync.turnOn();
    await sync.syncNow();

    expect(sync.state()).toMatchObject({ setup: "on", fault: null, activity: "idle" });
    expect(remote.requests[0]).toBe("GET git-receive-pack");
    expect(JSON.parse(await runGit(remote.bare, ["show", "main:metrists.json"]))).toEqual({ sync: { enabled: true } });
    expect(await runGit(remote.bare, ["show", "main:local.md"])).toBe("Before sync was on.");
    expect(JSON.parse(await read(join(ws, ".notefig", "sync.json")))).toMatchObject({ on: true });
    expect(await read(join(ws, ".git", "info", "exclude"))).toContain(".claude/");
  });

  it("refuses to turn on without push access, saying what to fix", async () => {
    const { sync, remote } = await setup("plain");
    remote.mode = "unauthorized";
    await expect(sync.turnOn()).rejects.toThrow(/Paste a token with write access/);
    expect(sync.state().setup).toBe("off");
  });

  it("asks a clone of a synced project; no keeps a local copy, yes syncs", async () => {
    const { sync, remote, ws, core } = await setup("asked");
    expect(sync.state()).toMatchObject({ setup: "ask", remote: { branch: "main" } });

    await sync.decline();
    await fsp.writeFile(join(ws, "note.md"), "Mine only.\n");
    written(core, join(ws, "note.md"));
    await sync.syncNow();
    expect(sync.state().setup).toBe("declined");
    expect(await runGit(remote.bare, ["show", "main:note.md"])).not.toContain("Mine only");

    await sync.turnOn();
    await sync.syncNow();
    expect(sync.state().setup).toBe("on");
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("Mine only.");
  });

  it("stops every device when one turns it off for everyone", async () => {
    const { sync: a, remote, core, open } = await setup();
    const wsB = await remote.clone("device-b");
    await writeDevice(wsB, { on: true });
    const b = await open(wsB);

    await a.turnOffForEveryone();
    expect(a.state().setup).toBe("off");
    expect(JSON.parse(await runGit(remote.bare, ["show", "main:metrists.json"]))).toEqual({ sync: { enabled: false } });

    await b.syncNow();
    await vi.waitFor(() => expect(b.state().setup).toBe("off"));
    await expect(fsp.access(join(wsB, ".notefig", "sync.json"))).rejects.toThrow();
    void core;
  });
});

describe("sync: solo", () => {
  it("commits once per sitting and pushes, with the repo's identity", async () => {
    const { sync, files, remote, ws } = await setup();
    const before = await remote.tip();
    const requests = remote.requests.length;
    await files.collections.content.preload();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await files.file(join(ws, "note.md")).write("# Note\n\nEdited.\n");
    await files.file(join(ws, "note.md")).write("# Note\n\nEdited again.\n");
    await vi.advanceTimersByTimeAsync(IDLE_COMMIT_MS - 1_000);
    expect(remote.requests.length).toBe(requests);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
    await sync.syncNow();

    await vi.waitFor(async () => expect(await remote.tip()).not.toBe(before));
    expect(await runGit(remote.bare, ["log", "-1", "--format=%an <%ae>|%s"])).toBe(
      "User device-a <device-a@test.local>|notefig: User device-a edited note.md",
    );
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("# Note\n\nEdited again.");
    expect(sync.state()).toMatchObject({ fault: null, activity: "idle" });
  });

  it("polls through a sitting without committing, and commits when it ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { sync, files, remote, ws } = await setup();
    await files.collections.content.preload();
    const head = await runGit(ws, ["rev-parse", "HEAD"]);
    await files.file(join(ws, "note.md")).write("# Note\n\nMid-sitting.\n");

    const polls = () => remote.requests.filter((r) => r.includes("upload-pack")).length;
    const before = polls();
    await vi.advanceTimersByTimeAsync(POLL_MS * 1.3);
    await vi.waitFor(() => expect(polls()).toBeGreaterThan(before));
    await vi.waitFor(() => expect(sync.state().activity).toBe("idle"));
    expect(await runGit(ws, ["rev-parse", "HEAD"])).toBe(head);

    // The poll didn't cancel the sitting's end.
    await vi.advanceTimersByTimeAsync(IDLE_COMMIT_MS);
    await vi.waitFor(async () => expect(await runGit(ws, ["rev-parse", "HEAD"])).not.toBe(head), { timeout: 5_000 });
    vi.useRealTimers();
    await sync.syncNow();
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("# Note\n\nMid-sitting.");
  });

  it("keeps .notefig/, ignored files, agent folders and the project's excludes out", async () => {
    const { sync, remote, ws, core } = await setup();
    const write = async (path: string, text: string) => {
      await fsp.mkdir(join(ws, path, ".."), { recursive: true });
      await fsp.writeFile(join(ws, path), text);
      written(core, join(ws, path));
    };
    await write(".gitignore", "*.tmp\n");
    await write("scratch.tmp", "ignored");
    await write(".notefig/scratchpads/pad.md", "mine");
    // Committed before sync came along: it stays as the remote has it.
    await remote.pushFromPlainGit(await remote.clone("plain"), { ".claude/settings.json": "{}" }, "old");
    await sync.syncNow();
    await write(".claude/settings.json", '{"local":true}');
    await write(".claude/settings.local.json", "{}");
    await write("notes.md", "Mine.\n");
    await sync.syncNow();
    expect(await tree(remote.bare)).toEqual([".claude/settings.json", ".gitignore", "metrists.json", "note.md", "notes.md"]);
    expect(await runGit(remote.bare, ["show", "main:.claude/settings.json"])).toBe("{}");

    await core.projectSettings.update(ws, { sync: { exclude: ["drafts/"] } });
    await sync.whenReady();
    await write("drafts/a.md", "Not yet.\n");
    await sync.syncNow();
    expect(await tree(remote.bare)).not.toContain("drafts/a.md");
  });

  it("stages many files with one index write", async () => {
    const { sync, ws, core, fs } = await setup();
    const names = Array.from({ length: 30 }, (_, n) => `batch-${n}.md`);
    await Promise.all(names.map((name) => fsp.writeFile(join(ws, name), name)));
    written(core, ...names.map((name) => join(ws, name)));
    const writes = vi.spyOn(fs, "writeBinaryFiles");
    await sync.syncNow();
    const indexWrites = writes.mock.calls.filter(([files]) => files.some((f) => /\/\.git\/index/.test(f.path)));
    expect(indexWrites.length).toBe(1);
  });

  it("scans from the last sync, not the last commit: a clone's old files aren't changes", async () => {
    const { core, ws, remote, open } = await setup();
    await core.workspace(ws).close();
    const lastSyncedAt = Date.now() - 60_000;
    await writeDevice(ws, { on: true, lastSyncedAt });
    const before = new Date(lastSyncedAt - 60_000);
    await fsp.writeFile(join(ws, "older.md"), "From before the last sync.\n");
    await fsp.utimes(join(ws, "older.md"), before, before);
    await fsp.writeFile(join(ws, "newer.md"), "Since then.\n");

    await open(ws);
    const files = await tree(remote.bare);
    expect(files).toContain("newer.md");
    expect(files).not.toContain("older.md");
  });

  it("commits and pushes what is left when the workspace closes", async () => {
    const { files, remote, ws, core } = await setup();
    await files.collections.content.preload();
    await files.file(join(ws, "note.md")).write("# Note\n\nLast words.\n");
    await core.workspace(ws).close();
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("# Note\n\nLast words.");
  });

  it("commits what changed while the app was closed, deletions included", async () => {
    const { core, ws, remote, open } = await setup();
    await core.workspace(ws).close();
    await fsp.writeFile(join(ws, "note.md"), "# Note\n\nEdited while closed.\n");
    await fsp.writeFile(join(ws, "added.md"), "Added while closed.\n");
    await open(ws);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("# Note\n\nEdited while closed.");
    expect(await runGit(remote.bare, ["show", "main:added.md"])).toBe("Added while closed.");

    await core.workspace(ws).close();
    await fsp.rm(join(ws, "added.md"));
    await open(ws);
    expect(await tree(remote.bare)).not.toContain("added.md");
  });

  it("brings a plain-git push into an open editor, keeping the caret", async () => {
    const { sync, remote, ws, editors, core } = await setup();
    const path = join(ws, "note.md");
    getOrCreateEditor(editors, path, { type: "markdown", content: codec.parse(await read(path)), basePath: ws }, editorFs);
    const editor = editors.markdownEditor(path)!;
    getDocumentSync(path).ensureBaseline(await read(path));
    const caret = editor.state.doc.child(0).nodeSize + 1 + 5;
    editor.commands.setTextSelection(caret);
    const applied = vi.fn();
    core.hooks.on("sync:remote-applied", applied);

    const plain = await remote.clone("plain");
    const pushed = await remote.pushFromPlainGit(
      plain,
      { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, edited elsewhere.\n", "docs/new.md": "A new file.\n" },
      "edit from the CLI",
    );
    await sync.syncNow();

    expect(await read(join(ws, "docs", "new.md"))).toBe("A new file.\n");
    expect(codec.serialize(editor.getJSON())).toContain("Second paragraph, edited elsewhere.");
    expect(editor.state.selection.from).toBe(caret);
    expect(applied).toHaveBeenCalledWith(expect.objectContaining({ commit: pushed }));
    expect(await runGit(ws, ["rev-parse", "HEAD"])).toBe(pushed);
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
    disposeEditor(editors, path);
  });

  it("replays local commits onto remote ones that touch other files", async () => {
    const { sync, remote, ws, core } = await setup();
    remote.mode = "offline";
    await fsp.writeFile(join(ws, "mine.md"), "Written offline.\n");
    written(core, join(ws, "mine.md"));
    await sync.syncNow();
    expect(sync.state().fault).toBe("offline");

    remote.mode = "ok";
    await remote.pushFromPlainGit(await remote.clone("plain"), { "theirs.md": "From the CLI.\n" }, "cli");
    await sync.syncNow();

    expect(sync.state().fault).toBe(null);
    expect(await tree(remote.bare)).toEqual(["metrists.json", "mine.md", "note.md", "theirs.md"]);
    expect(await read(join(ws, "theirs.md"))).toBe("From the CLI.\n");
  });

  it("merges a file both sides changed, flagging what a collision overwrote", async () => {
    const { sync, remote, ws, core } = await setup();
    const path = join(ws, "note.md");
    const seed = await runGit(ws, ["rev-parse", "HEAD"]);
    for (let n = 0; n < 50; n++) await runGit(ws, ["update-ref", `refs/notefig/recovery/0000000000000-${n}`, seed]);
    remote.mode = "offline";
    await fsp.writeFile(path, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
    written(core, path);
    await sync.syncNow();
    remote.mode = "ok";
    const theirs = await remote.pushFromPlainGit(
      await remote.clone("plain"),
      { "note.md": "# Note\n\nFirst paragraph, theirs.\n\nSecond paragraph, theirs.\n" },
      "cli",
    );
    await sync.syncNow();

    expect(sync.state().fault).toBe(null);
    const merged = "# Note\n\nFirst paragraph, theirs.\n\nSecond paragraph, theirs.\n";
    expect(await read(path)).toBe(merged);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe(merged.trimEnd());
    expect(await runGit(remote.bare, ["merge-base", "--is-ancestor", theirs, "main"])).toBe("");
    const kept = await runGit(ws, ["for-each-ref", "--format=%(refname)", "refs/notefig/recovery"]);
    expect(kept.split("\n")).toHaveLength(50);
    expect(kept).not.toContain("0000000000000-0\n");
    const [lost] = sync.state().overwritten;
    expect(lost).toMatchObject({ path: "note.md", text: "First paragraph, mine." });
    expect(await runGit(remote.bare, ["rev-list", "--merges", "--count", "main"])).toBe("0");

    // The whole of this side stays on a ref that never leaves the device.
    expect(await runGit(ws, ["show", `${lost.ref}:note.md`])).toContain("First paragraph, mine.");
    expect(await runGit(remote.bare, ["for-each-ref", "refs/notefig/recovery"])).toBe("");

    sync.dismissOverwritten();
    expect(sync.state().overwritten).toEqual([]);
  });

  it("merges edits to different paragraphs of one file with nothing flagged", async () => {
    const { sync, remote, ws, core } = await setup();
    const path = join(ws, "note.md");
    remote.mode = "offline";
    await fsp.writeFile(path, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
    written(core, path);
    await sync.syncNow();
    remote.mode = "ok";
    await remote.pushFromPlainGit(await remote.clone("plain"), { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n" }, "cli");
    await sync.syncNow();

    const merged = "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph, theirs.\n";
    expect(await read(path)).toBe(merged);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe(merged.trimEnd());
    expect(sync.state().overwritten).toEqual([]);
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
  });

  it("lets the branch's version of a non-markdown file stand, flagging mine", async () => {
    const { sync, remote, ws, core } = await setup();
    const path = join(ws, "data.txt");
    await fsp.writeFile(path, "base\n");
    written(core, path);
    await sync.syncNow();
    remote.mode = "offline";
    await fsp.writeFile(path, "mine\n");
    written(core, path);
    await sync.syncNow();
    remote.mode = "ok";
    await remote.pushFromPlainGit(await remote.clone("plain"), { "data.txt": "theirs\n" }, "cli");
    await sync.syncNow();

    expect(await read(path)).toBe("theirs\n");
    expect(sync.state().overwritten).toEqual([{ path: "data.txt", text: "mine\n", ref: expect.stringMatching(/^refs\/notefig\/recovery\//) }]);
  });

  it("holds remote content back from an editor with unsaved edits, and stops", async () => {
    const { sync, remote, ws, editors } = await setup();
    const path = join(ws, "note.md");
    getOrCreateEditor(editors, path, { type: "markdown", content: codec.parse(await read(path)), basePath: ws }, editorFs);
    const editor = editors.markdownEditor(path)!;
    const docSync = getDocumentSync(path);
    docSync.ensureBaseline(await read(path));
    // A save that never finishes: the edit is not on disk yet.
    docSync.writer = () => new Promise<void>(() => {});
    docSync.pushUpdate(() => editor.getJSON());

    await remote.pushFromPlainGit(await remote.clone("plain"), { "note.md": "# Note\n\nTheirs.\n" }, "cli");
    await sync.syncNow();

    expect(sync.state().fault).toBe("diverged");
    expect(codec.serialize(editor.getJSON())).not.toContain("Theirs.");
    disposeEditor(editors, path);
  });

  it("asks before going on after a long time away, and goes when told", async () => {
    const { core, ws, remote, open } = await setup();
    await core.workspace(ws).close();
    await writeDevice(ws, { on: true, lastSyncedAt: Date.now() - OFFLINE_RETURN_MS - 60_000 });
    await fsp.writeFile(join(ws, "note.md"), "# Note\n\nWritten on the plane.\n");
    await remote.pushFromPlainGit(await remote.clone("bob"), { "theirs.md": "Meanwhile.\n" }, "bob's change");
    const tipWhileAway = await remote.tip();

    const sync = await open(ws);
    expect(sync.state()).toMatchObject({
      fault: "paused",
      summary: { localFiles: ["note.md"], remoteFiles: ["theirs.md"], people: ["Plain Git"] },
    });
    expect(await remote.tip()).toBe(tipWhileAway);
    await expect(fsp.access(join(ws, "theirs.md"))).rejects.toThrow();

    sync.resume();
    await vi.waitFor(async () =>
      expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("# Note\n\nWritten on the plane."),
    );
    expect(await read(join(ws, "theirs.md"))).toBe("Meanwhile.\n");
  });

  it("stops at an auth error until resumed", async () => {
    const { sync, remote, ws, core } = await setup();
    remote.mode = "unauthorized";
    await fsp.writeFile(join(ws, "note.md"), "changed\n");
    written(core, join(ws, "note.md"));
    await sync.syncNow();
    expect(sync.state().fault).toBe("auth-error");
    const requests = remote.requests.length;
    await sync.syncNow();
    expect(remote.requests.length).toBe(requests);

    remote.mode = "ok";
    sync.resume();
    await sync.syncNow();
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("changed");
  });

  it("goes offline keeping the commit, and recovers on the next cycle", async () => {
    const { sync, remote, ws, core } = await setup();
    remote.mode = "offline";
    await fsp.writeFile(join(ws, "note.md"), "offline edit\n");
    written(core, join(ws, "note.md"));
    await sync.syncNow();
    expect(sync.state().fault).toBe("offline");
    expect(await runGit(ws, ["log", "-1", "--format=%s"])).toBe("notefig: User device-a edited note.md");

    remote.mode = "ok";
    await sync.syncNow();
    expect(sync.state().fault).toBe(null);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("offline edit");
  });

  it("re-polls after a push with no answer instead of pushing again", async () => {
    const { sync, remote, ws, core } = await setup();
    remote.mode = "hang-push";
    await fsp.writeFile(join(ws, "note.md"), "maybe landed\n");
    written(core, join(ws, "note.md"));
    await sync.syncNow();
    remote.mode = "ok";
    const pushes = () => remote.requests.filter((r) => r === "POST git-receive-pack").length;
    const before = pushes();
    await sync.syncNow();
    expect(pushes()).toBe(before);
    expect(await remote.tip()).toBe(await runGit(ws, ["rev-parse", "HEAD"]));
  });

  it("converges two devices that edited one file at once", async () => {
    const { sync: a, remote, ws: wsA, core, open } = await setup();
    const wsB = await remote.clone("device-b");
    await writeDevice(wsB, { on: true });
    const b = await open(wsB);
    const edit = async (ws: string, text: string) => {
      await fsp.writeFile(join(ws, "note.md"), text);
      written(core, join(ws, "note.md"));
    };

    await edit(wsA, "# Note\n\nFirst paragraph, from A.\n\nSecond paragraph.\n");
    await edit(wsB, "# Note\n\nFirst paragraph.\n\nSecond paragraph, from B.\n");
    await Promise.all([a.syncNow(), b.syncNow()]);
    await a.syncNow();
    await b.syncNow();
    await a.syncNow();

    const merged = "# Note\n\nFirst paragraph, from A.\n\nSecond paragraph, from B.\n";
    expect(await read(join(wsA, "note.md"))).toBe(merged);
    expect(await read(join(wsB, "note.md"))).toBe(merged);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe(merged.trimEnd());
    expect(await runGit(remote.bare, ["rev-list", "--merges", "--count", "main"])).toBe("0");
  });

  it("treats two clones open in one app as two devices", async () => {
    const { sync: a, remote, ws: wsA, core, open } = await setup();
    const wsB = await remote.clone("device-b");
    await writeDevice(wsB, { on: true });
    const b = await open(wsB);

    await fsp.writeFile(join(wsA, "from-a.md"), "Hello from A.\n");
    written(core, join(wsA, "from-a.md"));
    await a.syncNow();
    await b.syncNow();

    expect(await read(join(wsB, "from-a.md"))).toBe("Hello from A.\n");
    expect(await runGit(wsB, ["log", "-1", "--format=%an"])).toBe("User device-a");
  });
});

describe("sync: presence", () => {
  /** Two devices that have met: each saw the other's ref move. */
  async function twoDevices() {
    const { sync: a, remote, open, ...rest } = await setup();
    const wsB = await remote.clone("device-b");
    await writeDevice(wsB, { on: true });
    const b = await open(wsB);
    return { a, b, remote, open, wsB, ...rest };
  }
  const meet = async (a: { syncNow(): Promise<void>; state(): { peers: unknown[] } }, b: typeof a) => {
    // A new device's ref is read on the second look at it.
    for (let i = 0; i < 3 && (a.state().peers.length === 0 || b.state().peers.length === 0); i++) {
      await a.syncNow();
      await b.syncNow();
    }
  };

  it("sees another device and shows the others' names, no ref of its own", async () => {
    const { a, b } = await twoDevices();
    await meet(a, b);
    expect(a.state().peers).toMatchObject([{ deviceId: "device-b", name: "User device-b" }]);
    expect(b.state().peers).toMatchObject([{ deviceId: "device-a", name: "User device-a" }]);
  });

  it("writes presence as a commit on the tip, replaced, with no branch history", async () => {
    const { a, b, remote } = await twoDevices();
    const before = await remote.tip();
    await meet(a, b);
    expect(await remote.tip()).toBe(before);
    const ref = "refs/notefig/v1/presence/device-a";
    const parent = await runGit(remote.bare, ["rev-parse", `${ref}^`]);
    expect(parent).toBe(before);
    expect(JSON.parse(await runGit(remote.bare, ["log", "-1", "--format=%s", ref]))).toMatchObject({ name: "User device-a" });
  });

  it("a ref already there counts only when it moves, and goes when it stands still", async () => {
    const { a, b, remote, core, wsB } = await twoDevices();
    await core.workspace(wsB).close();
    await a.syncNow();
    await vi.waitFor(() => expect(a.state().peers).toEqual([]));
    void b;
    // A leftover nobody moves: a commit in place of a device's ref.
    const leftover = await runGit(remote.bare, ["rev-parse", "main"]);
    await runGit(remote.bare, ["update-ref", "refs/notefig/v1/presence/ghost", leftover]);
    await a.syncNow();
    expect(a.state().peers).toEqual([]);
  });

  it("leaves when the workspace closes: the ref is deleted", async () => {
    const { a, b, remote, core, wsB } = await twoDevices();
    await meet(a, b);
    await core.workspace(wsB).close();
    await expect(runGit(remote.bare, ["rev-parse", "--verify", "refs/notefig/v1/presence/device-b"])).rejects.toThrow();
    await a.syncNow();
    expect(a.state().peers).toEqual([]);
  });

  it("polls quickly with someone here, and doesn't commit on a poll", async () => {
    const { a, b, ws, core } = await twoDevices();
    await meet(a, b);
    expect(pollInterval(a.state())).toBe(SHARED_POLL_MS);
    const commits = await runGit(ws, ["rev-list", "--count", "main"]);
    written(core, join(ws, "note.md"));
    await new Promise((settle) => setTimeout(settle, SHARED_POLL_MS * 2.5));
    expect(await runGit(ws, ["rev-list", "--count", "main"])).toBe(commits);
  });

  it("draws a peer's caret on the unit it names", () => {
    const doc = createEditorDoc("# Note\n\n- one\n- two\n\nA paragraph.\n");
    expect(docUnits(doc)).toHaveLength(4);
    const peer = { deviceId: "b", name: "Bob", color: "#000", cursor: { path: "note.md", unit: 2, offset: 2 }, agents: [] };
    const set = caretDecorations(doc, "note.md", [peer]);
    expect(set.find()).toHaveLength(1);
    expect(caretDecorations(doc, "other.md", [peer]).find()).toHaveLength(0);
  });
});

describe("sync: claims and work in progress", { timeout: 60_000 }, () => {
  async function twoDevices() {
    const { sync: a, remote, open, ws, core, editors } = await setup();
    const wsB = await remote.clone("device-b");
    await writeDevice(wsB, { on: true });
    const b = await open(wsB);
    for (let i = 0; i < 3 && (a.state().peers.length === 0 || b.state().peers.length === 0); i++) {
      await a.syncNow();
      await b.syncNow();
    }
    return { a, b, remote, ws, wsB, core, editors };
  }
  const edit = async (core: Core, ws: string, text: string) => {
    await fsp.writeFile(join(ws, "note.md"), text);
    written(core, join(ws, "note.md"));
  };
  // The real poll, on real timers: a loaded machine runs it slowly.
  const until = (check: () => Promise<void> | void) => vi.waitFor(check, { timeout: 45_000, interval: 250 });
  const EDITED = "# Note\n\nAlice's paragraph.\n\nSecond paragraph.\n";

  it("keeps a sitting on a WIP ref with its claims, and folds it into one commit", async () => {
    const { a, remote, ws, core } = await twoDevices();
    const tip = await remote.tip();
    await edit(core, ws, EDITED);
    await until(async () => expect(await runGit(remote.bare, ["rev-parse", "--verify", "refs/notefig/v1/wip/device-a"])).toBeTruthy());
    expect(await remote.tip()).toBe(tip);
    expect(await runGit(remote.bare, ["show", "refs/notefig/v1/wip/device-a:note.md"])).toContain("Alice's paragraph");
    const claims = JSON.parse(await runGit(remote.bare, ["log", "-1", "--format=%s", "refs/notefig/v1/wip/device-a"])) as { claims: Record<string, string[]> };
    expect(claims.claims["note.md"]).toEqual(changedKeys(SEED["note.md"], EDITED));

    await a.syncNow();
    expect(await runGit(remote.bare, ["rev-list", "--count", `${tip}..main`])).toBe("1");
    await expect(runGit(remote.bare, ["rev-parse", "--verify", "refs/notefig/v1/wip/device-a"])).rejects.toThrow();
  });

  it("refuses an agent's write into a unit someone else holds, naming them", async () => {
    const { b, ws, wsB, core } = await twoDevices();
    await edit(core, ws, EDITED);
    await until(async () => {
      await expect(b.checkWrite(join(wsB, "note.md"), "# Note\n\nRewritten.\n\nSecond paragraph.\n")).resolves.toMatch(/User device-a is editing note\.md/);
    });
    // A targeted edit elsewhere goes through; an agent of the holder's too.
    await expect(b.checkWrite(join(wsB, "note.md"), "# Note\n\nFirst paragraph.\n\nSecond paragraph, by Bob.\n")).resolves.toBeNull();
    await expect(core.workspace(ws).sync.checkWrite(join(ws, "note.md"), "# Note\n\nMore.\n\nSecond paragraph.\n")).resolves.toBeNull();
  });

  it("settles a race deterministically: the lower device holds, the other's text is flagged", async () => {
    const { b, ws, wsB, core } = await twoDevices();
    await edit(core, ws, EDITED);
    await edit(core, wsB, "# Note\n\nBob's paragraph.\n\nSecond paragraph.\n");
    await until(async () => expect(await read(join(wsB, "note.md"))).toContain("First paragraph"));
    expect(b.state().overwritten).toEqual([{ path: "note.md", text: "Bob's paragraph." }]);
  });

  it("merges a peer's fold with the sitting it interrupts, and folds that sitting first", async () => {
    const { b, ws, wsB, core, remote } = await twoDevices();
    await edit(core, wsB, "# Note\n\nFirst paragraph.\n\nBob's second.\n");
    await until(async () => expect(await runGit(remote.bare, ["rev-parse", "--verify", "refs/notefig/v1/wip/device-b"])).toBeTruthy());
    const a = core.workspace(ws).sync;
    await edit(core, ws, EDITED);
    await a.syncNow();
    await until(async () => expect(await read(join(wsB, "note.md"))).toContain("Alice's paragraph"));
    expect(await read(join(wsB, "note.md"))).toContain("Bob's second");
    expect(b.state().fault).toBeNull();
  });

  it("reverts only the lost unit", () => {
    const base = "# T\n\nOne.\n\nTwo.\n";
    const next = "# T\n\nOne edited.\n\nTwo edited.\n";
    const [lost] = changedKeys(base, next).slice(0, 1);
    const reverted = revertUnits(base, next, new Set([lost]));
    expect(reverted).toEqual({ text: "# T\n\nOne.\n\nTwo edited.\n", dropped: ["One edited."] });
  });

  it("draws what others hold and refuses edits there", () => {
    const doc = createEditorDoc("# Note\n\nHeld paragraph.\n\nFree paragraph.\n");
    const peer = { deviceId: "b", name: "Bob", color: "#000", cursor: null, agents: [] };
    const md = "# Note\n\nHeld paragraph.\n\nFree paragraph.\n";
    const hold = { peer, keys: new Set(unitKeys(unitTexts(md)).slice(1, 2)), text: "# Note\n\nBob's words.\n\nFree paragraph.\n" };
    const state = holdDecorations(doc, md, [hold]);
    expect(state.ranges).toHaveLength(1);
    expect(state.set.find().some((d) => (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class === "sync-held")).toBe(true);
    expect(state.set.find().some((d) => (d as unknown as { type: { attrs?: { class?: string } } }).type.attrs?.class === "sync-overlaid")).toBe(true);

    const [range] = state.ranges;
    const editor = EditorState.create({ doc });
    expect(touchesHeld(editor.tr.insertText("x", range.from + 2), state.ranges)).toBe(true);
    const free = docUnits(doc)[2];
    expect(touchesHeld(editor.tr.insertText("x", free.from + 2), state.ranges)).toBe(false);
  });
});
