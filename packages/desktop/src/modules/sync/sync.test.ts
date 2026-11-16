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
import { getDocumentSync, whenDocumentSyncClean } from "@/utils/markdown-conversion";
import { IDLE_COMMIT_MS, POLL_MS, syncModule } from "@/modules/sync";
import { OFFLINE_RETURN_MS } from "./sync-engine";
import * as merging from "./sync-merge";
import * as telemetry from "@/telemetry/telemetry";

// Each test runs a real remote: many `git http-backend` processes, slow
// when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

const codec = createMarkdownCodec();
const editorFs: EditorFs = {
  searchContent: vi.fn(async () => []),
  exists: vi.fn(async () => []),
  writeBinaryFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
};
const SYNCED = { ".notefig/config.json": '{\n  "sync": {\n    "enabled": true\n  }\n}\n' };
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
  await fsp.writeFile(join(ws, ".git", "notefig-sync.json"), JSON.stringify({ deviceId: "dev", ...device }));
}

/** A clone open in a core. `synced`: the project syncs and this device
 *  said yes (the default); `asked`: the project syncs, no answer yet;
 *  `plain`: the project doesn't sync. */
async function setup(mode: "synced" | "asked" | "plain" = "synced", extra: Record<string, string> = {}) {
  remote = await createTestRemote(mode === "plain" ? { ...SEED, ...extra } : { ...SEED, ...SYNCED, ...extra });
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
const written = (core: Core, ...paths: string[]) => core.hooks.emit("files:written", { paths, source: "user" });

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
    // What older builds wrote: it would keep the new config out of the commit.
    await fsp.appendFile(join(ws, ".git", "info", "exclude"), ".notefig/\n");

    await sync.turnOn();
    await sync.syncNow();

    expect(sync.state()).toMatchObject({ setup: "on", fault: null, activity: "idle" });
    expect(remote.requests[0]).toBe("GET git-receive-pack");
    expect(JSON.parse(await runGit(remote.bare, ["show", "main:.notefig/config.json"]))).toEqual({ sync: { enabled: true } });
    expect(await runGit(remote.bare, ["show", "main:local.md"])).toBe("Before sync was on.");
    expect(JSON.parse(await read(join(ws, ".git", "notefig-sync.json")))).toMatchObject({ on: true });
    expect(await read(join(ws, ".git", "info", "exclude"))).toContain(".claude/");
    expect((await read(join(ws, ".git", "info", "exclude"))).split("\n")).not.toContain(".notefig/");
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
    expect(JSON.parse(await runGit(remote.bare, ["show", "main:.notefig/config.json"]))).toEqual({ sync: { enabled: false } });

    await b.syncNow();
    await vi.waitFor(() => expect(b.state().setup).toBe("off"));
    await expect(fsp.access(join(wsB, ".git", "notefig-sync.json"))).rejects.toThrow();
    void core;
  });
});

describe("sync: solo", () => {
  it("asks a clone whose repository carries a device answer: consent stays out of what a clone gets", async () => {
    // The project syncs, and the repo "answers" yes where older builds
    // and this one keep a device's answer; this clone still asks.
    const yes = '{"deviceId":"x","on":true}';
    const { sync } = await setup("asked", { ".notefig/sync.json": yes, "notefig-sync.json": yes });
    expect(sync.state().setup).toBe("ask");
  });

  it("follows the checked-out branch: a terminal checkout restarts sync on the new one", async () => {
    const { sync, remote, ws, core } = await setup();
    const before = await remote.tip();
    await runGit(ws, ["checkout", "-q", "-b", "draft"]);
    await sync.syncNow();
    await vi.waitFor(() => expect(sync.state().remote?.branch).toBe("draft"));
    await sync.whenReady();

    await fsp.writeFile(join(ws, "draft.md"), "On the draft.\n");
    written(core, join(ws, "draft.md"));
    await sync.syncNow();

    expect(await remote.tip("draft")).toBe(await runGit(ws, ["rev-parse", "HEAD"]));
    expect(await remote.tip()).toBe(before);
  });

  it("leaves a branch that pulls from one remote branch and pushes to another to git", async () => {
    const { sync, ws } = await setup("plain");
    await runGit(ws, ["config", "branch.main.merge", "refs/heads/trunk"]);
    await sync.inspect();
    expect(sync.state()).toMatchObject({ setup: "unavailable", reason: expect.stringContaining("Sync needs them to be the same branch") });
  });

  it("finishes a pull whose write failed before committing anything, so the old file isn't pushed back", async () => {
    const { sync, remote, ws, fs } = await setup();
    const pushed = await remote.pushFromPlainGit(await remote.clone("plain"), { "image.bin": "PNG\u0000data" }, "binary");
    const image = join(ws, "image.bin");
    const realWrite = fs.writeBinaryFiles.bind(fs);
    const failing = vi.spyOn(fs, "writeBinaryFiles").mockImplementation(async (entries) =>
      entries.some((entry) => entry.path === image)
        ? { succeeded: [], failed: [{ path: image, type: "permission_denied", message: "read-only" }] }
        : realWrite(entries),
    );
    await sync.syncNow();
    expect(sync.state()).toMatchObject({ fault: "offline", detail: expect.stringContaining("image.bin") });

    failing.mockRestore();
    await sync.syncNow();
    expect(sync.state().fault).toBe(null);
    expect(await read(join(ws, "image.bin"))).toBe("PNG\u0000data");
    expect(await remote.tip()).toBe(pushed);
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
  });

  it("retries a half-done pull, merging what was saved since", async () => {
    const { sync, remote, ws, fs, core } = await setup();
    await remote.pushFromPlainGit(await remote.clone("plain"), { "a.md": "Remote a.\n", "m.bin": "PNG\u0000", "z.md": "Remote z.\n" }, "three");
    const blocked = join(ws, "m.bin");
    const realWrite = fs.writeBinaryFiles.bind(fs);
    const failing = vi.spyOn(fs, "writeBinaryFiles").mockImplementation(async (entries) =>
      entries.some((entry) => entry.path === blocked)
        ? { succeeded: [], failed: [{ path: blocked, type: "permission_denied", message: "read-only" }] }
        : realWrite(entries),
    );
    await sync.syncNow();
    expect(await read(join(ws, "a.md"))).toBe("Remote a.\n");
    expect(sync.state().fault).toBe("offline");

    // Saved while the pull waits: one it wrote already, one it hadn't.
    await fsp.writeFile(join(ws, "a.md"), "Mine since.\n");
    await fsp.writeFile(join(ws, "z.md"), "Mine too.\n");
    written(core, join(ws, "a.md"), join(ws, "z.md"));
    failing.mockRestore();
    await sync.syncNow();

    // The move finishes; the save it wrote over goes out on top, and the
    // one it hadn't reached is merged with the remote's (both added it).
    expect(sync.state()).toMatchObject({ fault: null, activity: "idle" });
    expect(await read(join(ws, "a.md"))).toBe("Mine since.\n");
    expect(await read(join(ws, "z.md"))).toBe("Remote z.\n\nMine too.\n");
    expect(await runGit(remote.bare, ["show", "main:z.md"])).toBe("Remote z.\n\nMine too.");
    expect(await runGit(remote.bare, ["show", "main:a.md"])).toBe("Mine since.");
    expect(await runGit(remote.bare, ["show", "main:m.bin"])).toBe("PNG\u0000");
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
  });

  it("closes within its deadline while a request hangs, and writes nothing after", async () => {
    const { sync, remote, ws, core } = await setup();
    const before = await runGit(ws, ["rev-parse", "HEAD"]);
    await remote.pushFromPlainGit(await remote.clone("plain"), { "note.md": "Changed elsewhere.\n" }, "elsewhere");
    const request = remote.http.request.bind(remote.http);
    let release!: () => void;
    const hung = new Promise<void>((done) => (release = done));
    remote.http.request = async (input) => {
      await hung;
      return request(input);
    };
    void sync.syncNow();
    await fsp.writeFile(join(ws, "mine.md"), "Unsaved to the remote.\n");
    written(core, join(ws, "mine.md"));

    const start = Date.now();
    await core.workspace(ws).close();
    expect(Date.now() - start).toBeLessThan(7_000);

    release();
    await new Promise((done) => setTimeout(done, 1_000));
    expect(await read(join(ws, "note.md"))).not.toBe("Changed elsewhere.\n");
    // Closing committed what was saved (that's local); the remote's change
    // never came in.
    expect(await runGit(ws, ["show", "HEAD:note.md"])).not.toBe("Changed elsewhere.");
    expect(await runGit(ws, ["log", "--format=%s", `${before}..HEAD`])).toBe("notefig: User device-a edited mine.md");
  }, 20_000);

  it("takes in a mode the file API can't set, and never commits it back: an executable bit, a symlink", async () => {
    const { sync, remote, ws, core } = await setup();
    const plain = await remote.clone("plain");
    await runGit(plain, ["update-index", "--chmod=+x", "note.md"]);
    await fsp.symlink("note.md", join(plain, "link.md"));
    await runGit(plain, ["add", "link.md"]);
    await runGit(plain, ["commit", "-q", "-m", "modes"]);
    await runGit(plain, ["push", "-q", remote.bare, "HEAD:main"]);
    await sync.syncNow();

    expect(sync.state().fault).toBe(null);
    expect(await runGit(ws, ["rev-parse", "HEAD"])).toBe(await remote.tip());
    // A symlink comes in as a file holding its target, as git writes it
    // where symlinks can't be made.
    expect(await read(join(ws, "link.md"))).toBe("note.md");
    await fsp.writeFile(join(ws, "mine.md"), "Mine.\n");
    written(core, join(ws, "mine.md"));
    await sync.syncNow();
    const listing = await runGit(remote.bare, ["ls-tree", "main"]);
    expect(listing).toMatch(/^100755 blob \w+\tnote\.md$/m);
    expect(listing).toMatch(/^120000 blob \w+\tlink\.md$/m);
    expect(listing).toMatch(/^100644 blob \w+\tmine\.md$/m);
  });

  it("takes in a file that became a folder, keeping and flagging a version of it only this device has", async () => {
    const { sync, remote, ws, core } = await setup("synced", { topics: "A file.\n" });
    remote.mode = "offline";
    await fsp.writeFile(join(ws, "topics"), "A file, mine.\n");
    written(core, join(ws, "topics"));
    await sync.syncNow();
    remote.mode = "ok";
    const plain = await remote.clone("plain");
    await runGit(plain, ["rm", "-q", "topics"]);
    await fsp.mkdir(join(plain, "topics"));
    await fsp.writeFile(join(plain, "topics", "first.md"), "In a folder.\n");
    await runGit(plain, ["add", "topics"]);
    await runGit(plain, ["commit", "-q", "-m", "folder"]);
    await runGit(plain, ["push", "-q", remote.bare, "HEAD:main"]);
    await sync.syncNow();

    expect(sync.state().fault).toBe(null);
    expect(await read(join(ws, "topics", "first.md"))).toBe("In a folder.\n");
    expect(await tree(remote.bare)).toEqual([".notefig/config.json", "note.md", "topics/first.md"]);
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
    const [lost] = sync.state().overwritten;
    expect(lost).toMatchObject({ path: "topics", text: "A file, mine.\n" });
    expect(await runGit(ws, ["show", lost!.recovery])).toBe("A file, mine.");
  });

  it("takes in a folder that became a file, keeping and flagging what only this device had in it", async () => {
    const { sync, remote, ws } = await setup("synced", { "topics/first.md": "In a folder.\n" });
    // Never committed: it stays out of the remote's change.
    await fsp.writeFile(join(ws, "topics", "draft.md"), "Only here.\n");
    const plain = await remote.clone("plain");
    await runGit(plain, ["rm", "-rq", "topics"]);
    await fsp.writeFile(join(plain, "topics"), "A file now.\n");
    await runGit(plain, ["add", "topics"]);
    await runGit(plain, ["commit", "-q", "-m", "file"]);
    await runGit(plain, ["push", "-q", remote.bare, "HEAD:main"]);
    await sync.syncNow();

    expect(sync.state().fault).toBe(null);
    expect(await read(join(ws, "topics"))).toBe("A file now.\n");
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
    expect(sync.state().overwritten).toEqual([expect.objectContaining({ path: "topics/draft.md", text: "Only here.\n" })]);
    expect(await runGit(ws, ["show", sync.state().overwritten[0]!.recovery])).toBe("Only here.");
  });

  it("never commits a file the excludes keep out, even when typing holds its merge back", async () => {
    const { sync, remote, ws, editors, core } = await setup("synced", { ".claude/plan.md": "# Plan\n\nFirst.\n\nSecond.\n" });
    const path = join(ws, ".claude", "plan.md");
    const { editor, land } = await editUnsaved(core, editors, ws, path, "# Plan\n\nFirst, mine.\n\nSecond.\n");
    await remote.pushFromPlainGit(await remote.clone("plain"), { ".claude/plan.md": "# Plan\n\nFirst.\n\nSecond, theirs.\n" }, "cli");
    await sync.syncNow();
    land();
    await vi.waitFor(async () => expect(await read(path)).toContain("mine"), { timeout: 10_000 });
    // Typing again, its save still on the way, holds the merge's write back.
    const docSync = getDocumentSync(path);
    let landAgain!: () => void;
    const again = new Promise<void>((done) => (landAgain = done));
    docSync.writer = async (markdown) => {
      await again;
      await fsp.writeFile(path, `${markdown}\n`);
    };
    editor.commands.setContent(codec.parse("# Plan\n\nFirst, mine again.\n\nSecond.\n"));
    docSync.pushUpdate(() => editor.getJSON());
    await sync.syncNow();
    await sync.syncNow();
    expect(await runGit(remote.bare, ["show", "main:.claude/plan.md"])).toBe("# Plan\n\nFirst.\n\nSecond, theirs.");

    // The next save is merged from where the edits started, keeping both.
    landAgain();
    await vi.waitFor(async () => expect(await read(path)).toContain("mine again"), { timeout: 10_000 });
    await sync.syncNow();
    expect(sync.state().fault).toBe(null);
    expect(await read(path)).toBe("# Plan\n\nFirst, mine again.\n\nSecond, theirs.\n");
    expect(await runGit(remote.bare, ["show", "main:.claude/plan.md"])).toBe("# Plan\n\nFirst.\n\nSecond, theirs.");
    disposeEditor(editors, path);
  });

  it("merges a file saved during the pull that commits other saved edits, rather than writing over it", async () => {
    const { sync, remote, ws } = await setup("synced", { "a.md": "A.\n" });
    const path = join(ws, "note.md");
    // Saved and not committed: the pull commits it, then fetches again.
    await fsp.writeFile(join(ws, "a.md"), "A, mine.\n");
    await remote.pushFromPlainGit(
      await remote.clone("plain"),
      { "a.md": "A.\n\nTheirs.\n", "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n" },
      "cli",
    );
    const request = remote.http.request.bind(remote.http);
    let fetches = 0;
    remote.http.request = async (input) => {
      // A save lands during that second fetch.
      if (input.method === "POST" && input.url.endsWith("git-upload-pack") && ++fetches === 2) {
        await fsp.writeFile(path, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
      }
      return request(input);
    };
    await sync.syncNow();
    await sync.syncNow();

    expect(sync.state()).toMatchObject({ fault: null, overwritten: [] });
    const merged = "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph, theirs.\n";
    expect(await read(path)).toBe(merged);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe(merged.trimEnd());
    expect(await runGit(remote.bare, ["show", "main:a.md"])).toBe("A, mine.\n\nTheirs.");
  });

  it("waits for an edit on its way to a file in a folder the remote turned into a file, then keeps it", async () => {
    const { sync, remote, ws, editors, core } = await setup("synced", { "topics/first.md": "# First\n\nIn a folder.\n" });
    const path = join(ws, "topics", "first.md");
    const note = join(ws, "note.md");
    const { land } = await editUnsaved(core, editors, ws, path, "# First\n\nIn a folder, mine.\n");
    const plain = await remote.clone("plain");
    await runGit(plain, ["rm", "-rq", "topics"]);
    await fsp.writeFile(join(plain, "topics"), "A file now.\n");
    await fsp.writeFile(join(plain, "note.md"), "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n");
    await runGit(plain, ["add", "-A"]);
    await runGit(plain, ["commit", "-q", "-m", "file"]);
    await runGit(plain, ["push", "-q", remote.bare, "HEAD:main"]);
    await sync.syncNow();

    // Taken in (the branch moved), but nothing cleared under the edit.
    expect(sync.state().fault).toBe(null);
    expect(await runGit(ws, ["rev-parse", "HEAD"])).toBe(await remote.tip());
    expect(await read(path)).toBe("# First\n\nIn a folder.\n");

    // Saved while the move waits: merged, not written over.
    await fsp.writeFile(note, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
    land();
    await vi.waitFor(async () => expect(await read(path)).toContain("mine"), { timeout: 10_000 });
    await sync.syncNow();
    expect(await read(join(ws, "topics"))).toBe("A file now.\n");
    const [kept] = sync.state().overwritten;
    expect(kept).toMatchObject({ path: "topics/first.md", text: "# First\n\nIn a folder, mine.\n" });
    expect(await runGit(ws, ["show", kept!.recovery])).toContain("In a folder, mine.");
    await sync.syncNow();
    const merged = "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph, theirs.\n";
    expect(await read(note)).toBe(merged);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe(merged.trimEnd());
    disposeEditor(editors, path);
  });

  it("never clears a folder it couldn't read", async () => {
    const { sync, remote, ws, fs } = await setup("synced", { "topics/first.md": "In a folder.\n" });
    await fsp.writeFile(join(ws, "topics", "draft.md"), "Only here.\n");
    const plain = await remote.clone("plain");
    await runGit(plain, ["rm", "-rq", "topics"]);
    await fsp.writeFile(join(plain, "topics"), "A file now.\n");
    await runGit(plain, ["add", "topics"]);
    await runGit(plain, ["commit", "-q", "-m", "file"]);
    await runGit(plain, ["push", "-q", remote.bare, "HEAD:main"]);
    const readDirectory = fs.readDirectory.bind(fs);
    // Sync's listing of the folder fails; git's own reads still work.
    const denied = vi.spyOn(fs, "readDirectory").mockImplementation(async (path, options) =>
      path.endsWith("topics") && options?.recursive
        ? ({ ok: false, error: { type: "permission_denied", path, message: "denied" } } as never)
        : readDirectory(path, options),
    );
    await sync.syncNow();

    expect(sync.state()).toMatchObject({ fault: "offline", detail: "Couldn't read topics: denied" });
    expect(await read(join(ws, "topics", "draft.md"))).toBe("Only here.\n");

    denied.mockRestore();
    await sync.syncNow();
    expect(sync.state().fault).toBe(null);
    expect(await read(join(ws, "topics"))).toBe("A file now.\n");
    expect(sync.state().overwritten).toEqual([expect.objectContaining({ path: "topics/draft.md", text: "Only here.\n" })]);
  });

  it("replays local commits into a folder the remote turned into a file, flagging them", async () => {
    const { sync, remote, ws, core } = await setup("synced", { "topics/first.md": "In a folder.\n" });
    remote.mode = "offline";
    await fsp.writeFile(join(ws, "topics", "first.md"), "In a folder, mine.\n");
    await fsp.writeFile(join(ws, "topics", "new.md"), "New here.\n");
    written(core, join(ws, "topics", "first.md"), join(ws, "topics", "new.md"));
    await sync.syncNow();
    remote.mode = "ok";
    const plain = await remote.clone("plain");
    await runGit(plain, ["rm", "-rq", "topics"]);
    await fsp.writeFile(join(plain, "topics"), "A file now.\n");
    await runGit(plain, ["add", "topics"]);
    await runGit(plain, ["commit", "-q", "-m", "file"]);
    await runGit(plain, ["push", "-q", remote.bare, "HEAD:main"]);
    await sync.syncNow();

    expect(sync.state().fault).toBe(null);
    expect(await read(join(ws, "topics"))).toBe("A file now.\n");
    expect(await tree(remote.bare)).toEqual([".notefig/config.json", "note.md", "topics"]);
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
    const flagged = sync.state().overwritten;
    expect(flagged.map((item) => item.path).sort()).toEqual(["topics/first.md", "topics/new.md"]);
    expect(await runGit(ws, ["show", flagged.find((item) => item.path === "topics/new.md")!.recovery])).toBe("New here.");
  });

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
    expect(await tree(remote.bare)).toEqual([".claude/settings.json", ".gitignore", ".notefig/config.json", "note.md", "notes.md"]);
    expect(await runGit(remote.bare, ["show", "main:.claude/settings.json"])).toBe("{}");
    // Deleting it here leaves it there too.
    await fsp.rm(join(ws, ".claude", "settings.json"));
    written(core, join(ws, ".claude", "settings.json"));
    await sync.syncNow();
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
    expect(await tree(remote.bare)).toEqual([".notefig/config.json", "mine.md", "note.md", "theirs.md"]);
    expect(await read(join(ws, "theirs.md"))).toBe("From the CLI.\n");
  });

  it("merges a file both sides changed, flagging what a collision replaced and keeping it", async () => {
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
    expect(await runGit(remote.bare, ["rev-list", "--merges", "--count", "main"])).toBe("0");
    const [lost] = sync.state().overwritten;
    expect(lost).toMatchObject({ path: "note.md", text: "First paragraph, mine.", recovery: expect.stringMatching(/^refs\/notefig\/recovery\/.+:note\.md$/) });

    // This side stays whole on a ref that never leaves the device; the oldest go.
    expect(await runGit(ws, ["show", lost!.recovery])).toContain("First paragraph, mine.");
    const kept = await runGit(ws, ["for-each-ref", "--format=%(refname)", "refs/notefig/recovery"]);
    expect(kept.split("\n")).toHaveLength(50);
    expect(kept).not.toContain("0000000000000-0\n");
    expect(await runGit(remote.bare, ["for-each-ref", "refs/notefig"])).toBe("");

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

  it("commits a saved edit the remote also changed before merging it", async () => {
    const { sync, remote, ws } = await setup();
    const path = join(ws, "note.md");
    // Saved, and not committed yet (no save reached sync: a poll would see it).
    await fsp.writeFile(path, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
    await remote.pushFromPlainGit(await remote.clone("plain"), { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n" }, "cli");
    await sync.syncNow();

    expect(sync.state().fault).toBe(null);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("# Note\n\nFirst paragraph, mine.\n\nSecond paragraph, theirs.");
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
  });

  it("takes the remote's version of a file whose merge throws, flagging mine and reporting it", async () => {
    const { sync, remote, ws, core } = await setup();
    const path = join(ws, "note.md");
    remote.mode = "offline";
    await fsp.writeFile(path, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
    written(core, path);
    await sync.syncNow();
    remote.mode = "ok";
    await remote.pushFromPlainGit(
      await remote.clone("plain"),
      { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n", "other.md": "Other.\n" },
      "cli",
    );
    const boom = new Error("boom");
    const merge = vi.spyOn(merging, "mergeMarkdown").mockRejectedValue(boom);
    const reported = vi.spyOn(telemetry, "captureError");
    await sync.syncNow();
    merge.mockRestore();

    expect(sync.state().fault).toBe(null);
    expect(reported).toHaveBeenCalledWith(boom, { boundary: "sync-merge" });
    reported.mockRestore();
    expect(await read(path)).toBe("# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n");
    expect(await read(join(ws, "other.md"))).toBe("Other.\n");
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
    const [lost] = sync.state().overwritten;
    expect(lost).toMatchObject({ path: "note.md", text: "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n" });
    expect(await runGit(ws, ["show", lost!.recovery])).toContain("First paragraph, mine.");
  });

  it("lets the branch's version of a file that isn't markdown stand, flagging mine", async () => {
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
    const [lost] = sync.state().overwritten;
    expect(lost).toMatchObject({ path: "data.txt", text: "mine\n" });
    expect(await runGit(ws, ["show", lost!.recovery])).toBe("mine");
  });

  it("takes the remote's version of a file the excludes keep from syncing, keeping and flagging the one edited here", async () => {
    const { sync, remote, ws } = await setup("synced", { ".claude/settings.json": "{}\n" });
    await fsp.writeFile(join(ws, ".claude", "settings.json"), '{"mine":true}\n');
    await remote.pushFromPlainGit(await remote.clone("plain"), { ".claude/settings.json": '{"theirs":true}\n', "other.md": "Other.\n" }, "cli");
    await sync.syncNow();

    expect(sync.state().fault).toBe(null);
    expect(await read(join(ws, ".claude", "settings.json"))).toBe('{"theirs":true}\n');
    expect(await read(join(ws, "other.md"))).toBe("Other.\n");
    const [lost] = sync.state().overwritten;
    expect(lost).toMatchObject({ path: ".claude/settings.json", text: '{"mine":true}\n' });
    expect(await runGit(ws, ["show", lost!.recovery])).toBe('{"mine":true}');
  });

  it("offers the remote's version of a rewritten branch, keeping this one on the device", async () => {
    const { sync, remote, ws, core } = await setup("synced", { ".claude/settings.json": "{}\n" });
    // Edited, and kept out of every commit by the excludes.
    await fsp.writeFile(join(ws, ".claude", "settings.json"), '{"mine":true}\n');
    await fsp.writeFile(join(ws, "mine.md"), "Only here.\n");
    written(core, join(ws, "mine.md"));
    await sync.syncNow();
    const before = await runGit(ws, ["rev-parse", "HEAD"]);
    const plain = await remote.clone("rewriter");
    await runGit(plain, ["checkout", "-q", "--orphan", "fresh"]);
    await runGit(plain, ["rm", "-rqf", "."]);
    for (const [file, text] of Object.entries({ ...SYNCED, "fresh.md": "A new start.\n", ".claude/settings.json": '{"theirs":true}\n' })) {
      await fsp.mkdir(join(plain, file, ".."), { recursive: true });
      await fsp.writeFile(join(plain, file), text);
    }
    await runGit(plain, ["add", "-A"]);
    await runGit(plain, ["commit", "-qm", "rewrite"]);
    await runGit(plain, ["push", "-qf", remote.bare, "fresh:main"]);
    const rewritten = await remote.tip();

    await sync.syncNow();
    expect(sync.state()).toMatchObject({ fault: "diverged" });
    expect(await read(join(ws, "mine.md"))).toBe("Only here.\n");

    sync.takeRemote();
    await vi.waitFor(() => expect(sync.state()).toMatchObject({ fault: null }), { timeout: 10_000 });
    await sync.syncNow();
    expect(await runGit(ws, ["rev-parse", "HEAD"])).toBe(rewritten);
    expect(await read(join(ws, "fresh.md"))).toBe("A new start.\n");
    await expect(fsp.access(join(ws, "mine.md"))).rejects.toThrow();
    expect(await read(join(ws, ".claude", "settings.json"))).toBe('{"theirs":true}\n');
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
    const replaced = sync.state().overwritten.map((item) => item.path);
    expect(replaced).toEqual(expect.arrayContaining(["mine.md", "note.md"]));
    const kept = sync.state().overwritten.find((item) => item.path === "note.md")!;
    expect(await runGit(ws, ["rev-parse", kept.recovery.split(":")[0]!])).toBe(before);
    const settings = sync.state().overwritten.find((item) => item.path === ".claude/settings.json")!;
    expect(settings.text).toBe('{"mine":true}\n');
    expect(await runGit(ws, ["show", settings.recovery])).toBe('{"mine":true}');
    expect(await remote.tip()).toBe(rewritten);
  });

  /** An editor on `path` with an edit whose save waits for `land()`. */
  async function editUnsaved(core: Core, editors: ReturnType<typeof createEditors>, ws: string, path: string, text: string) {
    getOrCreateEditor(editors, path, { type: "markdown", content: codec.parse(await read(path)), basePath: ws }, editorFs);
    const editor = editors.markdownEditor(path)!;
    const docSync = getDocumentSync(path);
    docSync.ensureBaseline(await read(path));
    let land!: () => void;
    const landed = new Promise<void>((done) => (land = done));
    docSync.writer = async (markdown) => {
      await landed;
      await fsp.writeFile(path, `${markdown}\n`);
      written(core, path);
    };
    editor.commands.setContent(codec.parse(text));
    docSync.pushUpdate(() => editor.getJSON());
    return { editor, land };
  }

  it("holds a remote change back from an editor with unsaved edits, and merges once they're saved", async () => {
    const { sync, remote, ws, editors, core } = await setup();
    const path = join(ws, "note.md");
    const { editor, land } = await editUnsaved(core, editors, ws, path, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
    await remote.pushFromPlainGit(await remote.clone("plain"), { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n" }, "cli");
    await sync.syncNow();

    // Held, not stopped: the editor and the file keep what they had, and
    // nothing commits the stale file over the remote's.
    expect(sync.state().fault).toBe(null);
    expect(codec.serialize(editor.getJSON())).not.toContain("theirs");
    expect(await read(path)).toBe(SEED["note.md"]);
    expect(JSON.parse(await read(join(ws, ".git", "notefig-sync.json"))).held).toHaveProperty(["note.md"]);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toContain("Second paragraph, theirs.");

    land();
    await vi.waitFor(async () => expect(await read(path)).toBe("# Note\n\nFirst paragraph, mine.\n\nSecond paragraph, theirs.\n"), {
      timeout: 10_000,
    });
    await sync.syncNow();
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("# Note\n\nFirst paragraph, mine.\n\nSecond paragraph, theirs.");
    expect(codec.serialize(editor.getJSON())).toContain("Second paragraph, theirs.");
    expect(JSON.parse(await read(join(ws, ".git", "notefig-sync.json"))).held).toBeUndefined();
    expect(await runGit(ws, ["status", "--porcelain"])).toBe("");
    expect(sync.state()).toMatchObject({ fault: null, overwritten: [] });
    disposeEditor(editors, path);
  });

  it("merges a held file's save that lands while a pull is on its way, rather than writing over it", async () => {
    const { sync, remote, ws, editors, core } = await setup();
    const path = join(ws, "note.md");
    const plain = await remote.clone("plain");
    const { land } = await editUnsaved(core, editors, ws, path, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
    await remote.pushFromPlainGit(plain, { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n" }, "cli");
    await sync.syncNow();
    await remote.pushFromPlainGit(plain, { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n\nThird, theirs.\n" }, "cli");
    // The save lands during the next pull's fetch.
    const request = remote.http.request.bind(remote.http);
    let landed = false;
    remote.http.request = async (input) => {
      if (!landed && input.method === "POST" && input.url.endsWith("git-upload-pack")) {
        landed = true;
        land();
        await vi.waitFor(async () => expect(await read(path)).toContain("mine"));
      }
      return request(input);
    };
    await sync.syncNow();
    await sync.syncNow();

    const merged = "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph, theirs.\n\nThird, theirs.\n";
    await vi.waitFor(async () => expect(await read(path)).toBe(merged), { timeout: 10_000 });
    await sync.syncNow();
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe(merged.trimEnd());
    disposeEditor(editors, path);
  });

  it("merges again when a save lands during a merge, instead of writing the older result", async () => {
    const { sync, remote, ws, editors, core } = await setup();
    const path = join(ws, "note.md");
    const { land } = await editUnsaved(core, editors, ws, path, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
    await remote.pushFromPlainGit(await remote.clone("plain"), { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n" }, "cli");
    await sync.syncNow();
    const real = merging.mergeMarkdown;
    const merge = vi.spyOn(merging, "mergeMarkdown").mockImplementationOnce(async (base, ours, theirs) => {
      // A newer save, while the worker merges the older one.
      await fsp.writeFile(path, "# Note\n\nFirst paragraph, mine, again.\n\nSecond paragraph.\n");
      return real(base, ours, theirs);
    });
    land();
    await vi.waitFor(() => expect(merge).toHaveBeenCalled(), { timeout: 10_000 });
    await sync.syncNow();
    await sync.syncNow();

    const merged = "# Note\n\nFirst paragraph, mine, again.\n\nSecond paragraph, theirs.\n";
    expect(await read(path)).toBe(merged);
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe(merged.trimEnd());
    merge.mockRestore();
    disposeEditor(editors, path);
  });

  it("merges a held file after a restart, when its edits landed while closed", async () => {
    const { sync, remote, ws, editors, core, open } = await setup();
    const path = join(ws, "note.md");
    const { land } = await editUnsaved(core, editors, ws, path, "# Note\n\nFirst paragraph, mine.\n\nSecond paragraph.\n");
    await remote.pushFromPlainGit(await remote.clone("plain"), { "note.md": "# Note\n\nFirst paragraph.\n\nSecond paragraph, theirs.\n" }, "cli");
    await sync.syncNow();
    // Sync closes while the editor still holds its edits; their save lands
    // after it.
    await core.workspace(ws).close();
    land();
    await vi.waitFor(async () => expect(await read(path)).toContain("First paragraph, mine."));
    await whenDocumentSyncClean(path);
    disposeEditor(editors, path);

    const reopened = await open(ws);
    await reopened.syncNow();
    expect(await read(path)).toBe("# Note\n\nFirst paragraph, mine.\n\nSecond paragraph, theirs.\n");
    expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("# Note\n\nFirst paragraph, mine.\n\nSecond paragraph, theirs.");
    expect(JSON.parse(await read(join(ws, ".git", "notefig-sync.json"))).held).toBeUndefined();
    void sync;
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
    await vi.waitFor(
      async () => expect(await runGit(remote.bare, ["show", "main:note.md"])).toBe("# Note\n\nWritten on the plane."),
      { timeout: 10_000 },
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
    expect([a.state().overwritten, b.state().overwritten]).toEqual([[], []]);
  });
});
