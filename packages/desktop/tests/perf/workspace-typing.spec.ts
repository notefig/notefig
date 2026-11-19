/**
 * SLOs: typing and autosave (keystroke → the file rewritten on disk) in the
 * 8,000-line document, for each kind of workspace. A kind other than
 * "regular" names its SLOs with a suffix (`input-delete-solo-sync`), so a
 * comparison between kinds is a diff of rows.
 *
 * And opening a solo sync workspace: from "open" to the end of its first
 * sync cycle, which scans the tree for edits made while closed, commits
 * them and polls the remote, with the main thread's long tasks meanwhile.
 * Typing there is measured after that cycle, so it measures what each
 * keystroke costs, not how far the cycle overlapped it.
 *
 * Kept in its own spec, which sorts last, so its saves don't disturb the
 * scenarios the other specs measure.
 */
import { test, type Page } from "@playwright/test";
import path from "node:path";
import {
  autosave,
  installProbe,
  readSamples,
  scenario,
  setLabel,
  type PerfSamples,
} from "./latency";
import {
  openLargeDocument,
  PLACES,
  placeCaret,
  typeAndDelete,
} from "./large-document";
import { resetLargeDocument, soloSyncWorkspace } from "./fixture";
import { saveSamples } from "./results";
import { withShim } from "./shim";

/** Measured opens of the solo sync workspace per run. */
const SYNC_OPEN_SAMPLES = Number(process.env.PERF_SYNC_OPEN_SAMPLES ?? 8);

/** A workspace's sync, as the page reaches it. */
interface PageSync {
  state(): { activity: string; fault: string | null };
  subscribe(listener: () => void): () => void;
}

/**
 * In the page: open `workspace` (unless `open` is false: it already is),
 * then wait out its first sync cycle; returns how long that took. The
 * fixture's remote is a port nothing listens on, so the cycle ends
 * offline. Labelled "sync-open" when it opens, for its long tasks.
 */
async function untilFirstSync(args: { workspace: string; open: boolean }): Promise<number> {
  if (args.open) window.__perf.setLabel("sync-open");
  const start = performance.now();
  if (args.open && !(await window.__notefigTest.openProject(args.workspace)))
    throw new Error(`could not open ${args.workspace}`);
  const core = window.__notefigCore as unknown as {
    workspace(path: string): { sync: PageSync };
  };
  const sync = core.workspace(args.workspace).sync;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("no first sync in 60 s")), 60_000);
    const check = () => {
      const { activity, fault } = sync.state();
      if (activity !== "idle" || fault !== "offline") return;
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    };
    const unsubscribe = sync.subscribe(check);
    check();
  });
  const elapsed = performance.now() - start;
  if (args.open) window.__perf.setLabel(null);
  return elapsed;
}

/** What kind of workspace is measured. */
type WorkspaceKind = "regular" | "solo-sync";

/**
 * Opens the large document in a `kind` of workspace: the one place
 * "solo-sync" differs from "regular" is a copy of the fixture that is a git
 * repo whose project syncs (MET-270).
 */
async function openWorkspace(
  page: Page,
  kind: WorkspaceKind,
): Promise<string> {
  return openLargeDocument(
    page,
    kind === "solo-sync" ? await soloSyncWorkspace() : undefined,
  );
}

/** Autosave latencies: a key and its undo at every place, each timed to the write. */
async function measureAutosave(page: Page, file: string): Promise<number[]> {
  const saved: number[] = [];
  for (const place of PLACES) {
    await placeCaret(page, place);
    for (const key of ["x", "Backspace"])
      saved.push(await autosave(page, file, key));
  }
  return saved;
}

test("autosave in a regular workspace", async ({ page }) => {
  await withShim(async () => {
    await installProbe(page);
    const file = await openWorkspace(page, "regular");
    const samples = await readSamples(page);
    samples.latency.autosave = await measureAutosave(page, file);
    await saveSamples("typing-regular", samples);
    await page.goto("about:blank");
  });
});

test("type and autosave in a solo sync workspace", async ({ page }) => {
  await withShim(async () => {
    await installProbe(page);
    const file = await openWorkspace(page, "solo-sync");
    await page.evaluate(untilFirstSync, { workspace: path.dirname(file), open: false });
    await scenario(page, "input-delete-solo-sync", async () => {
      for (const place of PLACES) {
        await setLabel(page, null);
        await placeCaret(page, place);
        await setLabel(page, "input-delete-solo-sync");
        await typeAndDelete(page);
      }
    });
    const saved = await measureAutosave(page, file);
    const samples = await readSamples(page);
    samples.latency["autosave-solo-sync"] = saved;
    await saveSamples("typing-solo-sync", samples);
    await page.goto("about:blank");
  });
});

test("open a solo sync workspace until its first sync is done", async ({ page }) => {
  const workspace = await soloSyncWorkspace();
  await installProbe(page);
  const samples: PerfSamples = {
    latency: { "sync-open": [] },
    longTasks: { "sync-open": [] },
  };
  // One extra, unrecorded open first, to warm the disk cache.
  for (let i = 0; i <= SYNC_OPEN_SAMPLES; i++) {
    // An edit made while the app was closed, for the cycle to commit.
    await resetLargeDocument(workspace);
    const { ms, longTasks } = await withShim(async () => {
      await page.goto("/");
      await page.waitForFunction(() => Boolean(window.__notefigTest));
      const ms = await page.evaluate(untilFirstSync, { workspace, open: true });
      const { longTasks } = await readSamples(page);
      await page.goto("about:blank");
      return { ms, longTasks: longTasks["sync-open"] ?? [] };
    });
    if (i === 0) continue;
    samples.latency["sync-open"].push(ms);
    samples.longTasks["sync-open"].push(...longTasks);
  }
  await saveSamples("sync-open", samples);
});
