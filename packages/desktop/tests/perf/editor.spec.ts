/**
 * SLOs: keystroke latency in an 8,000-line document with tables and six
 * prompt widgets — caret moves, a caret move out of a select-all, typing
 * and deleting, and typing and caret moves inside a widget's draft.
 *
 * The caret visits the places listed in ./large-document. Everything typed
 * is deleted again, so the document ends each scenario as it began.
 */
import { test, expect } from "@playwright/test";
import { WIDGETS } from "./fixture";
import {
  type EditorElement,
  openLargeDocument,
  PLACES,
  placeCaret,
  TYPED,
  typeAndDelete,
} from "./large-document";
import {
  installProbe,
  readSamples,
  scenario,
  setLabel,
  stroke,
} from "./latency";
import { saveSamples } from "./results";
import { withShim } from "./shim";

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

/** Mod is Control: the Desktop Chrome profile reports a Windows platform. */
const SELECT_ALL = "Control+a";

const SELECT_ALL_ROUNDS = 12;

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
