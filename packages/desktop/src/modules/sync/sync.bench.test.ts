/**
 * What sync costs in a large workspace, step by step: opening a project
 * that doesn't sync, starting sync (the scan for edits made while closed),
 * an idle poll, committing and pushing one edit, and taking in one remote
 * change. In-process, over Node's fs and a local `git http-backend`, so the
 * numbers are sync's own work (git and fs calls), without the network or
 * the worker hop.
 *
 *   SYNC_BENCH=1 SYNC_BENCH_FILES=20000 npx vitest run src/modules/sync/sync.bench.test.ts
 */
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { defineModule, type Core } from "@notefig/core";
import { createTestCore } from "@/testing/test-core";
import { createTestRemote, inProcessGitWorker, nodeFs, runGit, type TestRemote } from "@/testing/test-sync";
import { createDocuments } from "@/modules/documents";
import { createWorkspaceFiles, type WorkspaceFiles } from "@/modules/files";
import { createEditors } from "@/modules/editors";
import { projectSettingsModule } from "@/modules/project-settings";
import { syncModule } from "@/modules/sync";

const FILES = Number(process.env.SYNC_BENCH_FILES ?? 20_000);
const RUNS = 7;
const CONFIG = { ".notefig/config.json": '{\n  "sync": {\n    "enabled": true\n  }\n}\n' };

function seed(count: number, synced: boolean): Record<string, string> {
  const files: Record<string, string> = synced ? { ...CONFIG } : {};
  for (let i = 0; i < count; i++) {
    files[`notes/${Math.floor(i / 200)}/note-${i}.md`] = `# Note ${i}\n\nSome text for note ${i}.\n`;
  }
  return files;
}

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
const results: Record<string, string> = {};
const remotes: TestRemote[] = [];
const cores: Core[] = [];

async function time(label: string, runs: number, step: () => Promise<void>, before?: () => Promise<void>) {
  const samples: number[] = [];
  for (let run = 0; run < runs; run++) {
    await before?.();
    const start = performance.now();
    await step();
    samples.push(performance.now() - start);
  }
  results[label] = `${median(samples).toFixed(1)} ms (median of ${runs}, max ${Math.max(...samples).toFixed(1)})`;
}

async function workspace(synced: boolean) {
  const remote = await createTestRemote(seed(FILES, synced));
  remotes.push(remote);
  const ws = await remote.clone("bench");
  if (synced) await fsp.writeFile(join(ws, ".git", "notefig-sync.json"), JSON.stringify({ deviceId: "bench", on: true, lastSyncedAt: Date.now() + 5_000 }));
  const fs = nodeFs();
  const filesByPath = new Map<string, WorkspaceFiles>();
  const editors = createEditors();
  const core = createTestCore({
    modules: [
      defineModule({
        name: "files",
        workspace: {
          create: (ctx) => {
            const files = createWorkspaceFiles({ workspacePath: ctx.workspace.path, fs, queryClient: new QueryClient(), hooks: ctx.hooks });
            filesByPath.set(ctx.workspace.path, files);
            return files;
          },
          dispose: (instance) => instance.dispose(),
        },
      }),
      defineModule({
        name: "documents",
        register: (ctx) => createDocuments({ fs, openFiles: () => [...filesByPath.values()], editors, hooks: ctx.hooks }),
      }),
      inProcessGitWorker(fs, remote.http),
      projectSettingsModule,
      syncModule,
    ],
    platform: { fs, gitHttp: { supported: true, request: remote.http.request } },
  });
  cores.push(core);
  await core.boot();
  return { remote, ws, core };
}

describe.skipIf(!process.env.SYNC_BENCH)(`sync in a ${FILES}-file workspace`, () => {
  afterAll(async () => {
    for (const core of cores) await core.dispose();
    for (const remote of remotes) remote.cleanup();
    console.table(results);
  });

  it("opens a project that doesn't sync without touching git", async () => {
    const { ws, core, remote } = await workspace(false);
    await time("open, project doesn't sync", 1, async () => {
      await core.workspace(ws).open();
      await core.workspace(ws).sync.whenReady();
    });
    expect(remote.requests).toEqual([]);
  }, 600_000);

  it("starts, polls, commits and pulls", async () => {
    const { ws, core, remote } = await workspace(true);
    // Edited while the app was closed (the scan finds these).
    await new Promise((done) => setTimeout(done, 6_000));
    for (let i = 0; i < 100; i++) {
      await fsp.writeFile(join(ws, "notes", "5", `note-${1000 + i}.md`), `Edited while closed ${i}.\n`);
    }
    const sync = () => core.workspace(ws).sync;
    // Open, read the remote, scan for edits made while closed, first cycle.
    await time("start: open, scan (100 edited), commit, push", 1, async () => {
      await core.workspace(ws).open();
      await sync().whenReady();
      await sync().syncNow();
    });
    expect(sync().state()).toMatchObject({ setup: "on", fault: null });

    await time("idle poll (nothing changed)", RUNS, () => sync().syncNow());

    let edit = 0;
    await time("commit + push one edited file", RUNS, async () => {
      const path = join(ws, "notes", "0", "note-0.md");
      await fsp.writeFile(path, `# Note 0\n\nEdit ${edit++}.\n`);
      core.hooks.emit("files:written", { paths: [path], source: "user" });
      await sync().syncNow();
    });
    expect(await remote.tip()).toBe(await runGit(ws, ["rev-parse", "HEAD"]));

    const plain = await remote.clone("plain");
    let change = 0;
    await time(
      "take in one remote change",
      RUNS,
      () => sync().syncNow(),
      async () => void (await remote.pushFromPlainGit(plain, { "notes/1/note-200.md": `From elsewhere ${change++}.\n` }, "elsewhere")),
    );
    expect(await fsp.readFile(join(ws, "notes", "1", "note-200.md"), "utf8")).toBe(`From elsewhere ${change - 1}.\n`);
  }, 900_000);
});
