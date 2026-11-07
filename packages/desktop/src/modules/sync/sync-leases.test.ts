/**
 * Leases end to end, in-process: two clones of one bare remote served by
 * `git http-backend`, each its own sync workspace (two devices) in one
 * core, with the real engine, worker API, merge, documents, editors and
 * write gate. They meet through presence and go shared; then leases are
 * taken in the same atomic push as content, drawn and made read-only in
 * the editor, gate agent writes, decide who wins a merge, and age out.
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
import type { GatedWrite } from "@/modules/write-gate";
import { leasePluginKey } from "./engine/lease-editor";
import { LEASE_STALE_MS } from "./lease-rules";
import { SyncLeaseRefusedError, SyncWriteMergedError } from "./engine/lease-gate";

const codec = createMarkdownCodec();
const editorFs: EditorFs = {
  searchContent: vi.fn(async () => []),
  exists: vi.fn(async () => []),
  writeBinaryFiles: vi.fn(async () => ({ succeeded: [], failed: [] })),
};
const BLOCKS = ["# Note", "First paragraph.", "Second paragraph.", "Third paragraph."];
const NOTE = `${BLOCKS.join("\n\n")}\n`;
const withBlock = (text: string, index: number, value: string) => {
  const blocks = text.trimEnd().split("\n\n");
  blocks[index] = value;
  return `${blocks.join("\n\n")}\n`;
};

let remote: TestRemote | null = null;
const cores: Core[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const core of cores.splice(0)) await core.dispose();
  remote?.cleanup();
  remote = null;
});

async function setup() {
  remote = await createTestRemote({ "note.md": NOTE });
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
  const refused: unknown[] = [];
  core.hooks.on("sync:lease-refused", (payload) => void refused.push(payload));

  const open = async (deviceId: string, name: string, color: string, extra: Partial<SyncConfig> = {}) => {
    const ws = await remote!.clone(deviceId);
    await fsp.mkdir(join(ws, ".notefig"), { recursive: true });
    await fsp.writeFile(
      syncConfigPath(ws),
      serializeSyncConfig({ remote: remote!.url, branch: "main", deviceId, presence: { name, color }, ...extra }),
    );
    await core.workspace(ws).open();
    const sync = core.workspace(ws).sync;
    await sync.whenReady();
    const note = join(ws, "note.md");
    return {
      ws,
      sync,
      note,
      deviceId,
      /** A person's save: the file changes, and files says so. */
      async type(block: number, value: string) {
        const now = await fsp.readFile(note, "utf8");
        await fsp.writeFile(note, withBlock(now, block, value));
        core.hooks.emit("files:written", { paths: [note], source: "app" });
      },
      read: () => fsp.readFile(note, "utf8"),
      /** An agent's ACP write, through the write gate. */
      agentWrite(content: string, taskId = "task-1") {
        const write: GatedWrite = {
          workspacePath: ws,
          path: note,
          content,
          writer: { kind: "agent", taskId, harness: "claude" },
        };
        const perform = vi.fn(async () => {
          await core.documents.write(note, content);
        });
        return { done: core.writeGate.run(write, perform), perform };
      },
    };
  };

  /** Both find each other through presence and go shared. */
  const meet = async (...devices: Array<Awaited<ReturnType<typeof open>>>) => {
    for (let round = 0; round < 2; round++) {
      for (const device of devices) await device.sync.syncNow();
    }
    for (const device of devices) expect(device.sync.capabilities().leases).toBe(true);
  };

  const openEditor = (path: string, ws: string, text: string) => {
    getOrCreateEditor(editors, path, { type: "markdown", content: codec.parse(text), basePath: ws }, editorFs);
    getDocumentSync(path).ensureBaseline(text);
    return editors.markdownEditor(path)!;
  };

  const lockRefs = async () =>
    (await runGit(remote!.bare, ["for-each-ref", "--format=%(refname)", "refs/notefig/v1/locks/"]))
      .split("\n")
      .filter(Boolean);

  const remoteNote = () => runGit(remote!.bare, ["show", "main:note.md"]);

  return { core, open, meet, openEditor, lockRefs, remoteNote, refused, remote: remote! };
}

const holderOfRef = (ref: string) => ref.split("/").pop();

describe("leases", () => {
  it("are taken in the same atomic push as the content, and every client maps them to the same block", async () => {
    const t = await setup();
    const a = await t.open("device-a", "Ada", "#8e4ec6");
    const b = await t.open("device-b", "Bo", "#46a758");
    await t.meet(a, b);
    const requests: string[][] = [];
    const request = t.remote.http.request.bind(t.remote.http);
    t.remote.http.request = async (spec) => {
      if (spec.url.endsWith("/git-receive-pack") && spec.body) {
        requests.push(
          Buffer.from(spec.body)
            .toString("latin1")
            .split("\n")
            .map((line) => line.split(" ")[2]?.split("\0")[0])
            .filter((ref): ref is string => !!ref?.startsWith("refs/")),
        );
      }
      return request(spec);
    };

    await a.type(2, "Second paragraph, rewritten by Ada.");
    await a.sync.syncNow();
    // One request carried the branch and Ada's lease.
    const content = requests.find((refs) => refs.includes("refs/heads/main"))!;
    expect(content).toHaveLength(2);
    expect(content[1]).toMatch(/^refs\/notefig\/v1\/locks\/[0-9a-f]{40}\/device-a$/);
    expect(await t.lockRefs()).toEqual([content[1]]);

    await b.sync.syncNow();
    const seenByA = a.sync.leases();
    const seenByB = b.sync.leases();
    expect(seenByA).toEqual([expect.objectContaining({ mine: true, blocks: [2] })]);
    expect(seenByB).toEqual([
      expect.objectContaining({ mine: false, blocks: [2], holder: expect.objectContaining({ name: "Ada" }) }),
    ]);
    // Bo's presence list shows what Ada holds.
    await b.sync.syncNow();
    expect(b.sync.presence()[0]?.holds).toBe(1);
  });

  it("two people typing in the same idle block: one gets the lease, the other's text is merged (holder wins), flagged, and the block is read-only for them", async () => {
    const t = await setup();
    const a = await t.open("device-a", "Ada", "#8e4ec6");
    const b = await t.open("device-b", "Bo", "#46a758");
    await t.meet(a, b);

    await a.type(1, "First paragraph, as Ada sees it.");
    await b.type(1, "First paragraph, as Bo wrote it!");
    await Promise.all([a.sync.syncNow(), b.sync.syncNow()]);
    // Settle: everyone pulls what landed.
    await a.sync.syncNow();
    await b.sync.syncNow();
    await a.sync.syncNow();

    const locks = await t.lockRefs();
    expect(locks).toHaveLength(1);
    const winner = holderOfRef(locks[0]) === "device-a" ? a : b;
    const loser = winner === a ? b : a;
    const winnerText = winner === a ? "First paragraph, as Ada sees it." : "First paragraph, as Bo wrote it!";
    expect(await t.remoteNote()).toContain(winnerText.replace("First paragraph, ", ""));
    expect(await loser.read()).toBe(await winner.read());
    // The loser's text was flagged (and kept on a recovery ref); it holds
    // no lease.
    expect(loser.sync.overwrites().length).toBeGreaterThan(0);
    expect(loser.sync.leases().filter((lease) => lease.mine)).toEqual([]);

    // The loser's editor: the block is drawn as the winner's and read-only.
    const text = await loser.read();
    const editor = t.openEditor(loser.note, loser.ws, text);
    await loser.sync.syncNow();
    await loser.sync.syncNow();
    await vi.waitFor(() => {
      expect(leasePluginKey.getState(editor.state)?.readOnly).toEqual([
        expect.objectContaining({ view: expect.objectContaining({ blockIndex: 1, mine: false }) }),
      ]);
    });
    const block1 = editor.state.doc.child(0).nodeSize + 2;
    const before = editor.state.doc.toJSON();
    editor.view.dispatch(editor.state.tr.insertText("typed ", block1));
    expect(editor.state.doc.toJSON()).toEqual(before);
    // Another block still takes typing.
    const block3 = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize + editor.state.doc.child(2).nodeSize + 2;
    editor.view.dispatch(editor.state.tr.insertText("ok ", block3));
    expect(editor.state.doc.child(3).textContent).toContain("ok ");
    const dom = editor.view.dom.querySelector(".sync-lease-label");
    expect(dom?.textContent).toBe(`${winner === a ? "Ada" : "Bo"} is editing`);
  });

  it("the lease holder wins an overlap even when the other side reached the branch first", async () => {
    const t = await setup();
    const a = await t.open("device-a", "Ada", "#8e4ec6");
    const b = await t.open("device-b", "Bo", "#46a758");
    await t.meet(a, b);
    await a.type(1, "First paragraph by Ada.");
    await a.sync.syncNow();
    await b.sync.syncNow();
    // Ada keeps typing in her block; Bo's racing write (straight to disk,
    // like a harness that writes files itself) reaches the branch first.
    await a.type(1, "First paragraph by Ada, continued.");
    await b.type(1, "First paragraph overwritten by a racing write.");
    await b.sync.syncNow();
    await a.sync.syncNow();
    await b.sync.syncNow();
    // Where both changed the same words, Ada's (the holder's) won, though
    // the racing write was on the branch first; Bo's non-overlapping
    // insert stays (the merge keeps edits that don't overlap).
    expect(await t.remoteNote()).toContain("by Ada, continued.");
    expect(await t.remoteNote()).not.toContain("racing write");
    expect(a.sync.overwrites().some((record) => record.fragments.join("").includes("racing"))).toBe(true);
  });

  it("refuses an agent's whole-file rewrite while a person holds a block, naming them, and writes nothing", async () => {
    const t = await setup();
    const a = await t.open("device-a", "Ada", "#8e4ec6");
    const b = await t.open("device-b", "Bo", "#46a758");
    await t.meet(a, b);
    await a.type(1, "First paragraph, Ada is on it.");
    await a.sync.syncNow();
    await b.sync.syncNow();
    const before = await b.read();

    const rewrite = BLOCKS.map((block) => `${block} (rewritten)`).join("\n\n");
    const { done, perform } = b.agentWrite(rewrite);
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncLeaseRefusedError);
    expect((error as Error).message).toContain("Ada");
    expect((error as Error).message).toContain("Nothing was written");
    expect(perform).not.toHaveBeenCalled();
    expect(await b.read()).toBe(before);
    expect(t.refused).toContainEqual(
      expect.objectContaining({ holder: expect.objectContaining({ id: "device-b/task-1", kind: "agent" }) }),
    );

    // A targeted edit to a free block goes through, leased to the agent.
    const targeted = withBlock(before, 3, "Third paragraph, by Bo's agent.");
    const ok = b.agentWrite(targeted);
    await ok.done;
    expect(ok.perform).toHaveBeenCalledOnce();
    expect(await t.remoteNote()).toContain("Third paragraph, by Bo's agent.");
    const agentLease = b.sync.leases().find((lease) => lease.holder.kind === "agent");
    expect(agentLease).toEqual(
      expect.objectContaining({ mine: true, blocks: [3], holder: expect.objectContaining({ id: "device-b/task-1" }) }),
    );
    // Ada sees it as Bo's agent's, in the presence list too.
    await a.sync.syncNow();
    await a.sync.syncNow();
    expect(a.sync.presence()[0]?.agents ?? []).toEqual([]);
    expect(a.sync.leases().find((lease) => lease.holder.kind === "agent")?.holder.name).toBe("Bo");
  });

  it("tells the agent when its write was merged, with the current text", async () => {
    const t = await setup();
    const a = await t.open("device-a", "Ada", "#8e4ec6");
    const b = await t.open("device-b", "Bo", "#46a758");
    await t.meet(a, b);
    // Ada edits block 2 and pushes; Bo hasn't polled since, so his agent's
    // gate can't know (a lost race).
    await a.type(2, "Second paragraph, Ada's words.");
    await a.sync.syncNow();
    const write = withBlock(NOTE, 2, "Second paragraph, the agent's words.");
    const { done, perform } = b.agentWrite(write);
    const error = await done.catch((e: unknown) => e);
    expect(perform).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(SyncWriteMergedError);
    const current = await b.read();
    expect((error as SyncWriteMergedError).current).toBe(current);
    expect((error as Error).message).toContain("was saved, then merged");
    expect((error as Error).message).toContain(current.trim());
    // Same-spot inserts are both kept, the branch's (Ada's) first.
    expect(current).toContain("Second paragraph, Ada's words, the agent's words.");
  });

  it("a killed holder's leases age out: its blocks become editable and can be taken over", async () => {
    const t = await setup();
    const a = await t.open("device-a", "Ada", "#8e4ec6");
    const b = await t.open("device-b", "Bo", "#46a758");
    await t.meet(a, b);
    await a.type(1, "First paragraph, then Ada's app died.");
    await a.sync.syncNow();
    await b.sync.syncNow();
    expect(b.sync.leases()).toHaveLength(1);

    // Ada's app dies: nothing reaches the remote on the way out.
    t.remote.mode = "offline";
    await t.core.workspace(a.ws).close();
    t.remote.mode = "ok";
    expect(await t.lockRefs()).toHaveLength(1);

    // Still respected until Bo has watched it stand still long enough.
    await b.sync.syncNow();
    expect(b.sync.leases()).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + LEASE_STALE_MS + 1_000 });
    await b.sync.syncNow();
    expect(b.sync.leases()).toEqual([]);

    // Bo's agent rewrites the whole file: granted, and Ada's stale lease
    // ref is deleted in the same push.
    const rewrite = BLOCKS.map((block) => `${block} (rewritten)`).join("\n\n") + "\n";
    const { done } = b.agentWrite(rewrite);
    await done;
    const locks = await t.lockRefs();
    expect(locks.map(holderOfRef)).toEqual(["device-b.2ftask-1"]);
  });
});
