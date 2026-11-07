/**
 * Presence end to end, in-process: two clones of one bare remote served by
 * `git http-backend`, each its own sync workspace (two devices) in one
 * core, the real engine and worker API, live editors. They find each other
 * through their presence refs, go shared, draw each other's carets, and go
 * back to solo when one closes — and presence never rides in a content
 * push.
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineModule, type Core } from "@notefig/core";
import { QueryClient } from "@tanstack/react-query";
import { createTestCore } from "@/testing/test-core";
import { createTestRemote, inProcessSyncRuntime, nodeFs, runGit, type TestRemote } from "@/testing/test-sync";
import { createDocuments } from "@/modules/documents";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/modules/files";
import { createEditors } from "@/modules/editors";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { getOrCreateEditor, type EditorFs } from "@/components/editor/editor-store";
import { getDocumentSync } from "@/utils/markdown-conversion";
import { serializeSyncConfig, syncConfigPath, syncModule, type SyncConfig } from "@/modules/sync";
import { presencePluginKey } from "./engine/presence-editor";
import { PRESENCE_MIN_INTERVAL_SHARED_MS } from "./engine/presence";

const codec = createMarkdownCodec();
const editorFs: EditorFs = {
  searchContent: vi.fn(async () => []),
  exists: vi.fn(async () => []),
  writeBinaryFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
};
const NOTE = ["# Note", "", "First paragraph.", "", "Second paragraph.", ""].join("\n");

let remote: TestRemote | null = null;
const cores: Core[] = [];

afterEach(async () => {
  for (const core of cores.splice(0)) await core.dispose();
  remote?.cleanup();
  remote = null;
});

/** The ref names in each receive-pack request's commands (`old new ref`). */
function pushedRefs(body: Uint8Array): string[] {
  const text = Buffer.from(body).toString("latin1");
  const refs: string[] = [];
  let at = 0;
  while (at + 4 <= text.length) {
    const length = Number.parseInt(text.slice(at, at + 4), 16);
    if (!length) break;
    const line = text.slice(at + 4, at + length).split("\0")[0].trim();
    const ref = line.split(" ")[2];
    if (ref) refs.push(ref);
    at += length;
  }
  return refs;
}

async function setup() {
  remote = await createTestRemote({ "note.md": NOTE });
  const receivePacks: string[][] = [];
  const request = remote.http.request.bind(remote.http);
  remote.http.request = async (spec) => {
    if (spec.url.endsWith("/git-receive-pack") && spec.body) receivePacks.push(pushedRefs(spec.body));
    return request(spec);
  };
  const fs = nodeFs();
  const filesByPath = new Map<string, WorkspaceFiles>();
  const editors = createEditors();
  const runtime = inProcessSyncRuntime(fs, remote);
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
      defineModule({ name: "editors", register: () => editors }),
      defineModule({
        name: "documents",
        register: (ctx) =>
          createDocuments({ fs, openFiles: () => [...filesByPath.values()], editors, hooks: ctx.hooks }),
      }),
      runtime.module,
      syncModule,
    ],
    platform: { fs },
  });
  cores.push(core);
  await core.boot();
  const open = async (deviceId: string, extra: Partial<SyncConfig> = {}) => {
    const ws = await remote!.clone(deviceId);
    await fsp.mkdir(join(ws, ".notefig"), { recursive: true });
    await fsp.writeFile(
      syncConfigPath(ws),
      serializeSyncConfig({ remote: remote!.url, branch: "main", deviceId, ...extra }),
    );
    await core.workspace(ws).open();
    const sync = core.workspace(ws).sync;
    await sync.whenReady();
    return { ws, sync, note: join(ws, "note.md") };
  };
  const openEditor = (path: string, ws: string) => {
    getOrCreateEditor(editors, path, { type: "markdown", content: codec.parse(NOTE), basePath: ws }, editorFs);
    getDocumentSync(path).ensureBaseline(NOTE);
    return editors.markdownEditor(path)!;
  };
  const presenceRefs = async () =>
    (await runGit(remote!.bare, ["for-each-ref", "--format=%(refname)", "refs/notefig/v1/presence/"]))
      .split("\n")
      .filter(Boolean);
  return { core, remote, open, openEditor, receivePacks, presenceRefs };
}

describe("presence", () => {
  it("two devices find each other within a poll, go shared, see each other, and go solo when one closes", async () => {
    const t = await setup();
    const a = await t.open("device-a", { presence: { name: "Ada", color: "#8e4ec6" } });
    await a.sync.syncNow();
    const b = await t.open("device-b", { author: { name: "Bo Git", email: "bo@example.com" } });
    // B's first poll sees A, but leaves it dormant (it may be a crash's
    // leftover), and publishes.
    await b.sync.syncNow();
    expect(await t.presenceRefs()).toEqual([
      "refs/notefig/v1/presence/device-a",
      "refs/notefig/v1/presence/device-b",
    ]);
    expect(b.sync.capabilities().presence).toBe(false);
    // A's next poll sees B appear: shared, and A greets back at once…
    await a.sync.syncNow();
    expect(a.sync.capabilities().presence).toBe(true);
    expect(a.sync.presence().map(({ name }) => name)).toEqual(["Bo Git"]);
    // …so B's next poll sees A move.
    await b.sync.syncNow();
    expect(b.sync.capabilities().presence).toBe(true);
    expect(b.sync.presence()).toEqual([
      expect.objectContaining({ deviceId: "device-a", name: "Ada", color: "#8e4ec6" }),
    ]);

    // B closes: its ref is deleted, and A is alone again on its next poll.
    await t.core.workspace(b.ws).close();
    expect(await t.presenceRefs()).toEqual(["refs/notefig/v1/presence/device-a"]);
    await a.sync.syncNow();
    expect(a.sync.capabilities().presence).toBe(false);
    expect(a.sync.capabilities().status).toBe("synced");
    expect(a.sync.presence()).toEqual([]);
  });

  it("attaches the editor plugin only at the shared level, and draws the other device's caret there", async () => {
    const t = await setup();
    const a = await t.open("device-a");
    const editorA = t.openEditor(a.note, a.ws);
    await a.sync.syncNow();
    // Alone: solo, and no plugin.
    expect(a.sync.capabilities().presence).toBe(false);
    expect(presencePluginKey.getState(editorA.state)).toBeUndefined();
    const b = await t.open("device-b", { presence: { name: "Bo", color: "#46a758" } });
    const editorB = t.openEditor(b.note, b.ws);
    await b.sync.syncNow();
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(presencePluginKey.getState(editorA.state)).toBeDefined();
    expect(presencePluginKey.getState(editorB.state)).toBeDefined();

    // B's caret, as its plugin reports it, in "Second paragraph." (block 2).
    b.sync.document(b.note).setCursor({
      anchor: { blockIndex: 2, offset: 1 },
      head: { blockIndex: 2, offset: 7 },
    });
    // A change goes out at most once a second at the shared level.
    await new Promise((resolve) => setTimeout(resolve, PRESENCE_MIN_INTERVAL_SHARED_MS + 50));
    await b.sync.syncNow();
    await a.sync.syncNow();
    await vi.waitFor(() => {
      const state = presencePluginKey.getState(editorA.state)!;
      expect(state.cursors).toEqual([
        expect.objectContaining({ holderId: "device-b", name: "Bo", color: "#46a758" }),
      ]);
      expect(state.decorations.find().length).toBeGreaterThan(0);
    });
    const peer = a.sync.presence()[0];
    expect(peer.cursors).toEqual([
      { path: a.note, anchor: { blockIndex: 2, offset: 1 }, head: { blockIndex: 2, offset: 7 } },
    ]);

    // B leaves: A goes solo and its plugin comes off.
    await t.core.workspace(b.ws).close();
    await a.sync.syncNow();
    expect(presencePluginKey.getState(editorA.state)).toBeUndefined();
  });

  it("never puts a presence update in the same request as a content push", async () => {
    const t = await setup();
    const a = await t.open("device-a");
    const b = await t.open("device-b");
    for (let i = 0; i < 3; i++) {
      await fsp.writeFile(a.note, `${NOTE}\nEdit ${i} by A.\n`);
      t.core.hooks.emit("files:written", { paths: [a.note], source: "app" });
      await a.sync.syncNow();
      await b.sync.syncNow();
    }
    const content = t.receivePacks.filter((refs) => refs.some((ref) => ref.startsWith("refs/heads/")));
    const presence = t.receivePacks.filter((refs) =>
      refs.some((ref) => ref.startsWith("refs/notefig/v1/presence/")),
    );
    expect(content.length).toBeGreaterThan(0);
    expect(presence.length).toBeGreaterThan(0);
    // A presence update is one ref, alone. A content push carries only the
    // branch and, at the shared level, the leases it acquires (MET-273).
    for (const refs of presence) expect(refs).toHaveLength(1);
    for (const refs of content) {
      expect(refs.slice(1).every((ref) => ref.startsWith("refs/notefig/v1/locks/"))).toBe(true);
    }
  });

  it("closing a workspace deletes its presence ref and leaves nothing running", async () => {
    const t = await setup();
    const a = await t.open("device-a");
    await a.sync.syncNow();
    expect(await t.presenceRefs()).toEqual(["refs/notefig/v1/presence/device-a"]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await t.core.workspace(a.ws).close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(await t.presenceRefs()).toEqual([]);
  });
});
