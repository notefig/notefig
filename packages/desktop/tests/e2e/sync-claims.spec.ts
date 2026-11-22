/**
 * Sync claims in the real editor (MET-273): a unit another device holds is
 * drawn paler, can't be typed in, and says who holds it. The sync editor
 * plugin is attached to the open editor with a peer that holds one
 * paragraph, as the engine attaches it while shared.
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

/** Attach the sync editor plugin with Ada holding the third unit; with
 *  `typed`, what she's typed in it so far, as her presence carries it. */
async function adaHoldsAParagraph(page: Page, typed?: string) {
  await page.evaluate(async ({ file, typed }) => {
    type Core = { editors: { markdownEditor(path: string): { state: { doc: unknown } } } };
    const core = (window as unknown as { __notefigCore: Core }).__notefigCore;
    // The dev server's modules, the app's own instances of them.
    const load = (name: string) => import(/* @vite-ignore */ `/src/modules/sync/${name}.ts`);
    const [{ createSyncEditors }, { createClaims }, { keyedUnits }] = await Promise.all(
      ["sync-editor", "sync-claims", "sync-units"].map(load),
    );
    const units = keyedUnits(core.editors.markdownEditor(file).state.doc);
    const peers = [
      { deviceId: "ada", name: "Ada", colour: "#c0562f", cursor: { path: "plan.md", unit: 2 }, claims: [{ path: "plan.md", keys: [units[2].key], agent: false }] },
    ];
    const claims = createClaims({ deviceId: "me", now: Date.now, peers: () => peers });
    const wip = typed
      ? [
          {
            named: "typed",
            key: "typed",
            node: { type: "paragraph", content: [{ type: "text", text: typed }] },
            at: 2,
            previous: units[1].key,
            holder: { peer: peers[0], agent: false },
            keys: [units[2].key, "typed"],
          },
        ]
      : [];
    createSyncEditors({
      editors: core.editors,
      tree: (path: string) => path.split("/").pop(),
      onCursor() {},
      claims,
      wip: { in: () => wip },
      setTimer: (run: () => void, ms: number) => {
        const handle = setTimeout(run, ms);
        return () => clearTimeout(handle);
      },
    }).reconcile({ peers });
  }, { file: FILE, typed });
}

test("a paragraph someone else is editing is paler, named, and refuses typing", async ({ page }) => {
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
  // No line in the gutter: the paleness and her name say it.
  expect(await held.evaluate((el) => getComputedStyle(el, "::before").content)).toBe("none");

  // Ada is named in a tag after the last word of the block she's in: no caret.
  await expect(held).toHaveAttribute("data-sync-names", "Ada");
  expect(await held.evaluate((el) => getComputedStyle(el, "::after").content)).toBe('"Ada"');
  expect(await held.evaluate((el) => getComputedStyle(el, "::after").display)).toBe("inline-block");
  await expect(editor.locator(".sync-caret")).toHaveCount(0);

  await held.click();
  await page.keyboard.type("x");
  await expect(held).toHaveText("Ada is editing this paragraph.");

  // Everywhere else types as ever.
  await editor.getByText("First paragraph, free to edit.").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Typed.");
  await expect(editor.getByText("First paragraph, free to edit. Typed.")).toBeVisible();
});

test("what someone else is typing is drawn over their paragraph, in its place", async ({ page }) => {
  await seed(page);
  await openWorkspace(page, WORKSPACE);
  await page.getByRole("treeitem", { name: "plan.md" }).click();
  const editor = page.locator(".ProseMirror");
  await expect(editor.locator("h1", { hasText: "Plan" })).toBeVisible({ timeout: 15_000 });
  await adaHoldsAParagraph(page, "Ada is editing this paragraph, and typing more.");
  const held = editor.locator(".sync-held");
  await expect(held.locator(".sync-wip")).toHaveText("Ada is editing this paragraph, and typing more.");
  await page.screenshot({ path: "test-results/sync-wip.png" });
  // One line, as wide as the paragraph: never a letter per line.
  const [wip, paragraph] = await Promise.all([held.locator(".sync-wip").boundingBox(), held.boundingBox()]);
  expect(wip!.height).toBeLessThan(40);
  expect(wip!.width).toBeGreaterThan(paragraph!.width / 2);
  // This copy's own text is hidden under it.
  await expect(held.locator(".sync-wip-hidden")).toBeHidden();
  // What she added is washed in her colour, and she's named on the block.
  await expect(held.locator(".sync-wash")).toHaveText(", and typing more");
  await expect(held).toHaveAttribute("data-sync-names", "Ada");
});
