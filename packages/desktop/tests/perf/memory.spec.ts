/**
 * Memory: the JS heap (page and workers) and DOM after each step of a
 * session over the 20,000-file workspace — boot, open the workspace, open
 * the 8,000-line document, open ten notes and close them twice, close the
 * workspace and open it again. Reported, not enforced: each step is a
 * sample in MB, so a leak shows as a step that doesn't come back down.
 *
 * Every reading is taken after two forced collections (CDP
 * HeapProfiler.collectGarbage), so it is what the app retains, not what
 * the collector hasn't reached yet.
 */
import { test, expect, type CDPSession, type Page } from "@playwright/test";
import path from "node:path";
import { perfWorkspace, resetLargeDocument, WIDGETS } from "./fixture";
import { saveSamples } from "./results";
import { withShim } from "./shim";

declare global {
  interface Window {
    __notefigTest: { openProject: (path: string) => Promise<boolean> };
    __notefigCore: {
      tabs: {
        open: (tabId: string, options: { intent: string }) => boolean;
        close: (tabId: string) => void;
      };
      workspace: (path: string) => { close: () => Promise<void> };
    };
  }
}

const MB = 1024 * 1024;

interface Reading {
  step: string;
  pageHeap: number;
  workerHeap: number;
  nodes: number;
  listeners: number;
}

/** Each worker's used heap, through the browser-level target list. */
async function workerHeaps(page: Page): Promise<number[]> {
  const browser = await page.context().browser()!.newBrowserCDPSession();
  try {
    const { targetInfos } = await browser.send("Target.getTargets");
    const workers = targetInfos.filter((t) => t.type === "worker");
    const heaps: number[] = [];
    for (const worker of workers) {
      const { sessionId } = await browser.send("Target.attachToTarget", {
        targetId: worker.targetId,
        flatten: false,
      });
      const call = (id: number, method: string) =>
        new Promise<unknown>((resolve) => {
          const onMessage = (event: { sessionId: string; message: string }) => {
            const message = JSON.parse(event.message);
            if (event.sessionId !== sessionId || message.id !== id) return;
            browser.off("Target.receivedMessageFromTarget", onMessage);
            resolve(message.result);
          };
          browser.on("Target.receivedMessageFromTarget", onMessage);
          void browser.send("Target.sendMessageToTarget", {
            sessionId,
            message: JSON.stringify({ id, method }),
          });
        });
      await call(1, "HeapProfiler.collectGarbage");
      const usage = (await call(2, "Runtime.getHeapUsage")) as {
        usedSize: number;
      };
      heaps.push(usage.usedSize);
      await browser.send("Target.detachFromTarget", { sessionId });
    }
    return heaps;
  } finally {
    await browser.detach();
  }
}

async function measure(
  page: Page,
  cdp: CDPSession,
  step: string,
): Promise<Reading> {
  await page.waitForTimeout(1500);
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  const { metrics } = await cdp.send("Performance.getMetrics");
  const metric = (name: string) =>
    metrics.find((m) => m.name === name)?.value ?? 0;
  const workers = await workerHeaps(page);
  return {
    step,
    pageHeap: usedSize / MB,
    workerHeap: workers.reduce((a, b) => a + b, 0) / MB,
    nodes: metric("Nodes"),
    listeners: metric("JSEventListeners"),
  };
}

const NOTES = Array.from(
  { length: 10 },
  (_, i) => `area-${i}/topic-${i}/note-${i}.md`,
);

test("memory across a session in a 20k-file workspace", async ({ page }) => {
  const workspace = await perfWorkspace();
  await resetLargeDocument(workspace);
  const readings: Reading[] = [];

  await withShim(async () => {
    await page.goto("/");
    await page.waitForFunction(() => Boolean(window.__notefigTest));
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const step = async (name: string) =>
      readings.push(await measure(page, cdp, name));

    const open = (file: string, intent = "new-tab") =>
      page.evaluate(
        ({ file, intent }) => window.__notefigCore.tabs.open(file, { intent }),
        { file: path.join(workspace, file), intent },
      );
    const close = (file: string) =>
      page.evaluate(
        (file) => window.__notefigCore.tabs.close(file),
        path.join(workspace, file),
      );
    const openWorkspace = async () => {
      await page.evaluate(
        (ws) => window.__notefigTest.openProject(ws),
        workspace,
      );
      await open("README.md", "replace");
      await expect(page.locator(".ProseMirror").first()).toBeVisible({
        timeout: 30_000,
      });
      await page.waitForTimeout(3000);
    };
    const tenNotes = async (round: number) => {
      for (const note of NOTES) {
        await open(note);
        await page.waitForTimeout(250);
      }
      await step(`ten-notes-open-${round}`);
      for (const note of NOTES) await close(note);
      await step(`ten-notes-closed-${round}`);
    };

    await page.waitForTimeout(2000);
    await step("boot");

    await openWorkspace();
    await step("workspace-open");

    await open("large.md");
    await expect(
      page.locator('.ProseMirror [data-type="ai-prompt"]'),
    ).toHaveCount(WIDGETS, { timeout: 30_000 });
    await page.waitForTimeout(3000);
    await step("large-doc-open");
    await close("large.md");
    await step("large-doc-closed");

    await tenNotes(1);
    await tenNotes(2);

    await page.evaluate(
      (ws) => window.__notefigCore.workspace(ws).close(),
      workspace,
    );
    await step("workspace-closed-1");
    await openWorkspace();
    await step("workspace-reopened");
    await page.evaluate(
      (ws) => window.__notefigCore.workspace(ws).close(),
      workspace,
    );
    await step("workspace-closed-2");

    await page.goto("about:blank");
  });

  console.table(
    readings.map((r) => ({
      step: r.step,
      "page MB": r.pageHeap.toFixed(1),
      "workers MB": r.workerHeap.toFixed(1),
      nodes: r.nodes,
      listeners: r.listeners,
    })),
  );
  await saveSamples("memory", {
    latency: Object.fromEntries(
      readings.map((r) => [`memory-${r.step}`, [r.pageHeap + r.workerHeap]]),
    ),
    longTasks: {},
  });
});
