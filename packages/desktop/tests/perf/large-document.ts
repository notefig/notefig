/**
 * The 8,000-line perf document: opening it, and placing the caret in it.
 * Shared by the specs that type in it.
 *
 * The caret visits the top, middle and end of the document, a table cell,
 * a list item, a heading and every widget, because what a keystroke costs
 * depends on where it lands.
 */
import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { perfWorkspace, resetLargeDocument, WIDGETS } from "./fixture";
import { stroke } from "./latency";

/** Where to put the caret: a kind of block, at a fraction of the doc. */
export type Target =
  | {
      kind: "paragraph" | "heading" | "tableCell" | "listItem";
      at: number;
    }
  | { kind: "widget"; index: number };

export const PLACES: Target[] = [
  { kind: "paragraph", at: 0.02 },
  { kind: "paragraph", at: 0.25 },
  { kind: "paragraph", at: 0.5 },
  { kind: "paragraph", at: 0.75 },
  { kind: "paragraph", at: 0.97 },
  { kind: "tableCell", at: 0.5 },
  { kind: "listItem", at: 0.5 },
  { kind: "heading", at: 0.5 },
];

export const TYPED = "abcdefgh";

export interface EditorElement extends HTMLElement {
  editor: {
    state: { doc: PmNode };
    chain(): {
      focus(): {
        setTextSelection(pos: number): {
          scrollIntoView(): { run(): boolean };
        };
      };
    };
  };
}

interface PmNode {
  type: { name: string };
  nodeSize: number;
  textContent: string;
  content: { size: number };
  isTextblock: boolean;
  descendants(
    fn: (node: PmNode, pos: number, parent: PmNode | null) => boolean | void,
  ): void;
}

/** In the page: the caret position `target` names, or -1. */
function caretFor(target: Target): number {
  const el = Array.from(
    document.querySelectorAll<EditorElement>(".ProseMirror"),
  ).find((e) => e.checkVisibility({ visibilityProperty: true }));
  if (!el) return -1;
  const doc = el.editor.state.doc;
  const from = target.kind === "widget" ? 0 : doc.content.size * target.at;
  let widgets = 0;
  let caret = -1;
  doc.descendants((node, pos, parent) => {
    if (caret >= 0) return false;
    if (node.type.name === "aiPrompt") {
      if (target.kind === "widget" && widgets++ === target.index)
        caret = pos + 1 + node.content.size;
      return false;
    }
    if (target.kind === "widget" || pos < from || !node.isTextblock) return;
    const wanted =
      target.kind === "heading"
        ? node.type.name === "heading"
        : node.type.name === "paragraph" &&
          (target.kind === "paragraph"
            ? parent === doc
            : parent?.type.name === target.kind);
    // Mid-text, so a horizontal arrow has somewhere to go both ways.
    if (wanted) caret = pos + 1 + Math.floor(node.content.size / 2);
  });
  if (caret >= 0)
    el.editor.chain().focus().setTextSelection(caret).scrollIntoView().run();
  return caret;
}

export async function placeCaret(page: Page, target: Target): Promise<void> {
  const caret = await page.evaluate(caretFor, target);
  expect(
    caret,
    `no caret position for ${JSON.stringify(target)}`,
  ).toBeGreaterThan(0);
  await page.waitForTimeout(300);
}

export async function typeAndDelete(page: Page): Promise<void> {
  for (const char of TYPED) await stroke(page, char);
  for (let i = 0; i < TYPED.length; i++) await stroke(page, "Backspace");
}

/** Open the large document in a fresh app load; returns its path. */
export async function openLargeDocument(page: Page): Promise<string> {
  const workspace = await perfWorkspace();
  await resetLargeDocument(workspace);
  const file = path.join(workspace, "large.md");
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__notefigTest));
  await page.evaluate(
    async ({ workspace, file }) => {
      await window.__notefigTest.openProject(workspace);
      window.__notefigCore.tabs.open(file, { intent: "replace" });
    },
    { workspace, file },
  );
  await expect(
    page.locator('.ProseMirror [data-type="ai-prompt"]'),
  ).toHaveCount(WIDGETS, { timeout: 30_000 });
  // Let the open's tail (tree, collections, minimap) settle first.
  await page.waitForTimeout(3000);
  return file;
}
