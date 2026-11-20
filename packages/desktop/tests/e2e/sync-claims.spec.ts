/**
 * Sync claims in the real editor (MET-273): a unit another device holds is
 * drawn paler with a line in their colour, can't be typed in, and says who
 * holds it. The sync editor plugin is attached to the open editor with a
 * peer that holds one paragraph, as the engine attaches it while shared.
 */
import { expect, test, type Page } from "@playwright/test";
import { openWorkspace } from "../setup/test-helpers";

const WORKSPACE = "/e2e-sync-claims-ws";
const FILE = `${WORKSPACE}/plan.md`;
const DOC = "# Plan\n\nFirst paragraph, free to edit.\n\nAda is editing this paragraph.\n\nLast paragraph.\n";

async function seed(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__NOTEFIG_FORCE_INDEXEDDB__ = true;
  });
  await page.goto("/");
  await page.evaluate(
    async ({ path, content }) => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open("notefig-fs", 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => req.result.createObjectStore("files", { keyPath: "path" });
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["files"], "readwrite");
        tx.objectStore("files").put({ path, content, modifiedAt: new Date(), createdAt: new Date() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { path: FILE, content: DOC },
  );
}

/** Attach the sync editor plugin with Ada holding the third unit. */
async function adaHoldsAParagraph(page: Page) {
  await page.evaluate(async (file) => {
    type Core = { editors: { markdownEditor(path: string): { state: { doc: unknown } } } };
    const core = (window as unknown as { __notefigCore: Core }).__notefigCore;
    // The dev server's modules, the app's own instances of them.
    const load = (name: string) => import(/* @vite-ignore */ `/src/modules/sync/${name}.ts`);
    const [{ createSyncEditors }, { createClaims }, { keyedUnits }] = await Promise.all(
      ["sync-editor", "sync-claims", "sync-units"].map(load),
    );
    const units = keyedUnits(core.editors.markdownEditor(file).state.doc);
    const peers = [
      { deviceId: "ada", name: "Ada", colour: "#c0562f", cursor: { path: "plan.md", unit: 1, offset: 5 }, claims: [{ path: "plan.md", keys: [units[2].key], agent: false }] },
    ];
    const claims = createClaims({ deviceId: "me", now: Date.now, peers: () => peers });
    createSyncEditors({
      editors: core.editors,
      tree: (path: string) => path.split("/").pop(),
      onCursor() {},
      claims,
      setTimer: (run: () => void, ms: number) => {
        const handle = setTimeout(run, ms);
        return () => clearTimeout(handle);
      },
    }).reconcile({ peers });
  }, FILE);
}

test("a paragraph someone else is editing is paler, marked in their colour, and refuses typing", async ({ page }) => {
  await seed(page);
  await openWorkspace(page, WORKSPACE);
  await page.getByRole("treeitem", { name: "plan.md" }).click();
  const editor = page.locator(".ProseMirror");
  await expect(editor.locator("h1", { hasText: "Plan" })).toBeVisible({ timeout: 15_000 });
  await expect(editor).toBeFocused({ timeout: 5_000 });
  await adaHoldsAParagraph(page);

  const held = editor.locator(".sync-held");
  await expect(held).toHaveText("Ada is editing this paragraph.");
  await expect(held).toHaveAttribute("title", "Ada is editing this");
  await expect(held).toHaveCSS("cursor", "not-allowed");
  // Paler once its 200 ms fade settles.
  await expect(held).toHaveCSS("opacity", "0.55");
  expect(await held.evaluate((el) => getComputedStyle(el, "::before").backgroundColor)).toBe("rgb(192, 86, 47)");

  // The line sits in the gutter, left of the text, whatever the indent.
  const lineLeft = await held.evaluate((el) => el.getBoundingClientRect().left + parseFloat(getComputedStyle(el, "::before").left));
  const textLeft = await editor.locator("h1").evaluate((el) => el.getBoundingClientRect().left);
  expect(lineLeft).toBeLessThan(textLeft);

  // Ada's caret carries her name, shown the moment it's hovered.
  const caret = editor.locator('.sync-caret[data-sync-peer="ada"]');
  expect(await caret.evaluate((el) => getComputedStyle(el, "::after").content)).toBe('"Ada"');
  await caret.hover({ force: true });
  await expect.poll(() => caret.evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("1");

  await held.click();
  await page.keyboard.type("x");
  await expect(held).toHaveText("Ada is editing this paragraph.");

  // Everywhere else types as ever.
  await editor.getByText("First paragraph, free to edit.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Typed.");
  await expect(editor.getByText("First paragraph, free to edit. Typed.")).toBeVisible();
});
