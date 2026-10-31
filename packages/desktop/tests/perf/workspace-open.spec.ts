/**
 * SLO: a 20,000-file workspace, from "open" to a file you can type in.
 *
 * Each sample is a fresh launch (a new shim process with an empty
 * database, a new page load): open the workspace as the user would, open
 * README.md, and stop at the first painted frame after its editor is
 * showing the file and editable. The disk cache is warm after the first sample; what this
 * guards is the app's own cost — the tree, the collections, the landing,
 * the editor mount — not the cold disk.
 */
import { test, type Page } from "@playwright/test";
import path from "node:path";
import { perfWorkspace, README_SENTINEL } from "./fixture";
import { installProbe, readSamples, type PerfSamples } from "./latency";
import { saveSamples } from "./results";
import { withShim } from "./shim";

/** Measured samples per run; the CI job runs several rounds. */
const SAMPLES = Number(process.env.PERF_OPEN_SAMPLES ?? 10);

declare global {
  interface Window {
    __notefigTest: { openProject: (path: string) => Promise<boolean> };
    __notefigCore: {
      tabs: { open: (tabId: string, options: { intent: string }) => boolean };
    };
  }
}

/** In the page: open, then wait for the file to be interactive. */
async function openUntilInteractive(args: {
  workspace: string;
  file: string;
  sentinel: string;
}): Promise<number> {
  const nextPaint = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      }),
    );
  const interactive = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '.ProseMirror[contenteditable="true"]',
      ),
    ).some(
      (el) =>
        el.checkVisibility({ visibilityProperty: true }) &&
        el.textContent?.includes(args.sentinel),
    );

  window.__perf.setLabel("workspace-open");
  const start = performance.now();
  if (!(await window.__notefigTest.openProject(args.workspace)))
    throw new Error(`could not open ${args.workspace}`);
  window.__notefigCore.tabs.open(args.file, { intent: "replace" });
  while (!interactive()) await nextPaint();
  // Detected after a paint; the frame that shows it is the next one.
  await nextPaint();
  const elapsed = performance.now() - start;
  window.__perf.setLabel(null);
  return elapsed;
}

/** One sample: load the app, open the workspace and its README. */
async function launchAndOpen(
  page: Page,
  workspace: string,
): Promise<{ ms: number; longTasks: number[] }> {
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__notefigTest));
  const ms = await page.evaluate(openUntilInteractive, {
    workspace,
    file: path.join(workspace, "README.md"),
    sentinel: README_SENTINEL,
  });
  // The workspace keeps loading in the background after the file is up;
  // let it finish so it isn't cut off by the next load.
  await page.waitForTimeout(1500);
  const { longTasks } = await readSamples(page);
  // Leave the app before its backend goes, so it isn't left erroring.
  await page.goto("about:blank");
  return { ms, longTasks: longTasks["workspace-open"] ?? [] };
}

test("open a 20k-file workspace until a file is interactive", async ({
  page,
}) => {
  const workspace = await perfWorkspace();
  await installProbe(page);
  const samples: PerfSamples = {
    latency: { "workspace-open": [] },
    longTasks: { "workspace-open": [] },
  };

  // One extra, unrecorded load first: it warms the disk cache and the
  // preview server, which no user's open pays twice.
  for (let i = 0; i <= SAMPLES; i++) {
    const { ms, longTasks } = await withShim(() =>
      launchAndOpen(page, workspace),
    );
    if (i === 0) continue;
    samples.latency["workspace-open"].push(ms);
    samples.longTasks["workspace-open"].push(...longTasks);
  }

  await saveSamples("workspace-open", samples);
});
