/**
 * SLOs: keystroke latency in an 8,000-line document with tables and six
 * prompt widgets — caret moves, a caret move out of a select-all, typing
 * and deleting, and typing and caret moves inside a widget's draft.
 *
 * The caret visits the top, middle and end of the document, a table cell,
 * a list item, a heading and every widget, because what a keystroke costs
 * depends on where it lands. Everything typed is deleted again, so the
 * document ends each scenario as it began.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { perfWorkspace, resetLargeDocument, WIDGETS } from "./fixture";
import {
  installProbe,
  readSamples,
  scenario,
  setLabel,
  stroke,
} from "./latency";
import { saveSamples } from "./results";
import { withShim } from "./shim";

/** Where to put the caret: a kind of block, at a fraction of the doc. */
type Target =
  | {
      kind: "paragraph" | "heading" | "tableCell" | "listItem";
      at: number;
    }
  | { kind: "widget"; index: number };

const PLACES: Target[] = [
  { kind: "paragraph", at: 0.02 },
  { kind: "paragraph", at: 0.25 },
  { kind: "paragraph", at: 0.5 },
  { kind: "paragraph", at: 0.75 },
  { kind: "paragraph", at: 0.97 },
  { kind: "tableCell", at: 0.5 },
  { kind: "listItem", at: 0.5 },
  { kind: "heading", at: 0.5 },
];

const CARET_KEYS = [
  "ArrowDown",
  "ArrowDown",
  "ArrowUp",
  "ArrowUp",
  "ArrowRight",
  "ArrowRight",
  "ArrowLeft",
  "ArrowLeft",
];

const TYPED = "abcdefgh";

/** Mod is Control: the Desktop Chrome profile reports a Windows platform. */
const SELECT_ALL = "Control+a";

const SELECT_ALL_ROUNDS = 12;

interface EditorElement extends HTMLElement {
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

async function placeCaret(page: Page, target: Target): Promise<void> {
  const caret = await page.evaluate(caretFor, target);
  expect(
    caret,
    `no caret position for ${JSON.stringify(target)}`,
  ).toBeGreaterThan(0);
  await page.waitForTimeout(300);
}

/** In the page: the draft text of widget `index`. */
function widgetDraft(index: number): string {
  const el = Array.from(
    document.querySelectorAll<EditorElement>(".ProseMirror"),
  ).find((e) => e.checkVisibility({ visibilityProperty: true }));
  const drafts: string[] = [];
  el?.editor.state.doc.descendants((node) => {
    if (node.type.name !== "aiPrompt") return;
    drafts.push(node.textContent);
    return false;
  });
  return drafts[index] ?? "";
}

async function typeAndDelete(page: Page): Promise<void> {
  for (const char of TYPED) await stroke(page, char);
  for (let i = 0; i < TYPED.length; i++) await stroke(page, "Backspace");
}

async function openLargeDocument(page: Page): Promise<void> {
  const workspace = await perfWorkspace();
  await resetLargeDocument(workspace);
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__notefigTest));
  await page.evaluate(
    async ({ workspace, file }) => {
      await window.__notefigTest.openProject(workspace);
      window.__notefigCore.tabs.open(file, { intent: "replace" });
    },
    { workspace, file: path.join(workspace, "large.md") },
  );
  await expect(
    page.locator('.ProseMirror [data-type="ai-prompt"]'),
  ).toHaveCount(WIDGETS, { timeout: 30_000 });
  // Let the open's tail (tree, collections, minimap) settle first.
  await page.waitForTimeout(3000);
}

test("edit an 8,000-line document with tables and widgets", async ({
  page,
}) => {
  await withShim(async () => {
    await installProbe(page);
    await openLargeDocument(page);

    await scenario(page, "caret-move", async () => {
      for (const place of PLACES) {
        await setLabel(page, null);
        await placeCaret(page, place);
        await setLabel(page, "caret-move");
        for (const key of [...CARET_KEYS, ...CARET_KEYS])
          await stroke(page, key);
      }
    });

    await placeCaret(page, { kind: "paragraph", at: 0.5 });
    for (let i = 0; i < SELECT_ALL_ROUNDS; i++) {
      await setLabel(page, "select-all");
      await stroke(page, SELECT_ALL);
      await page.waitForTimeout(300);
      await setLabel(page, "select-all-caret-move");
      await stroke(page, "ArrowDown");
      await setLabel(page, null);
      await page.waitForTimeout(300);
    }

    await scenario(page, "input-delete", async () => {
      for (const place of PLACES) {
        await setLabel(page, null);
        await placeCaret(page, place);
        await setLabel(page, "input-delete");
        await typeAndDelete(page);
      }
    });

    for (let index = 0; index < WIDGETS; index++) {
      await placeCaret(page, { kind: "widget", index });
      await scenario(page, "widget-input", async () => {
        for (const char of TYPED) await stroke(page, char);
      });
      expect(await page.evaluate(widgetDraft, index)).toBe(TYPED);
      await scenario(page, "widget-caret-move", async () => {
        for (const key of ["ArrowLeft", "ArrowLeft", "ArrowLeft", "ArrowLeft"])
          await stroke(page, key);
        for (const key of [
          "ArrowRight",
          "ArrowRight",
          "ArrowRight",
          "ArrowRight",
        ])
          await stroke(page, key);
      });
      await scenario(page, "widget-input", async () => {
        for (let i = 0; i < TYPED.length; i++) await stroke(page, "Backspace");
      });
      expect(await page.evaluate(widgetDraft, index)).toBe("");
    }

    await saveSamples("editor", await readSamples(page));
    await page.goto("about:blank");
  });
});
