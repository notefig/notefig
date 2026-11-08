/**
 * SLOs: typing and autosave (keystroke → the file rewritten on disk) in the
 * 8,000-line document, for each kind of workspace. A kind other than
 * "regular" names its SLOs with a suffix (`input-delete-solo-sync`), so a
 * comparison between kinds is a diff of rows.
 *
 * Kept in its own spec, which sorts last, so its saves don't disturb the
 * scenarios the other specs measure.
 */
import { test, type Page } from "@playwright/test";
import {
  autosave,
  installProbe,
  readSamples,
  scenario,
  setLabel,
} from "./latency";
import {
  openLargeDocument,
  PLACES,
  placeCaret,
  typeAndDelete,
} from "./large-document";
import { saveSamples } from "./results";
import { withShim } from "./shim";

/** What kind of workspace is measured. */
type WorkspaceKind = "regular" | "solo-sync";

/**
 * Opens the large document in a `kind` of workspace. MET-270: this is the
 * one place "solo-sync" will differ from "regular". Until sync exists it is
 * the same workspace. Then write its `.notefig/sync.json` here, in a copy of
 * the fixture (the fixture directory is shared, and reused, by other specs).
 */
async function openWorkspace(
  page: Page,
  _kind: WorkspaceKind,
): Promise<string> {
  return openLargeDocument(page);
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
