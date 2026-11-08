/**
 * Sync end to end, in-process: a real bare remote (`git http-backend`),
 * real clones on disk, the real module and engine, `@notefig/git` run
 * in-process where the app runs it in the git worker, files and documents
 * over Node's fs, and a live editor where one matters.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
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
import { IDLE_COMMIT_MS, POLL_MS, syncModule } from "@/modules/sync";
import { OFFLINE_RETURN_MS } from "./sync-engine";

// Each test runs many git http-backend processes.
vi.setConfig({ testTimeout: 30_000 });

const codec = createMarkdownCodec();
const editorFs: EditorFs = {
  searchContent: vi.fn(async () => []),
  exists: vi.fn(async () => []),
  writeBinaryFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
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
  await fsp.writeFile(join(ws, ".notefig", "sync.json"), JSON.stringify({ deviceId: "dev", ...device }));
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
