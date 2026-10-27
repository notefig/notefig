/**
 * Push-to-talk dictation, end to end: the bundled model (public/dictation/),
 * the real worker and the real editors. Only the microphone is a stand-in:
 * getUserMedia returns a stream that plays a recorded sentence. Everything
 * after it — capture, resampling, phrase cutting, live guesses, the wave, the
 * placeholders, the insert — is the app's own.
 *
 * The e2e page reports Windows, so the hold key is Right Ctrl.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openFileInTree,
  openWorkspace,
  seedTestFiles,
  setupTestDatabase,
  waitForFileTree,
} from "../setup/test-helpers";
import { composer, startMockSession } from "../agent/agent-helpers";

const here = dirname(fileURLToPath(import.meta.url));
/** "We should ship the dictation feature today, and review it tomorrow."
 *  (macOS `say`, 16 kHz mono, ~3.8 s) */
const CLIP = readFileSync(join(here, "fixtures", "dictation.wav")).toString("base64");
// Not the first word: where the fake mic's stream starts shifts by a few
// milliseconds between runs, and the model has heard "Sip" for "Ship".
const SPOKEN = /dictation feature today/i;
const HINT = "or hold right Ctrl to talk";

type Window_ = Window & { __say: () => Promise<void>; __notefigCore: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Replaces the microphone with one that plays CLIP on `__say()`, or one
 *  the user refused. */
async function fakeMicrophone(page: Page, { refused = false } = {}) {
  await page.addInitScript(
    ({ clip, refused }) => {
      navigator.mediaDevices.getUserMedia = async () => {
        if (refused) throw new DOMException("Permission denied", "NotAllowedError");
        const context = new AudioContext();
        const bytes = Uint8Array.from(atob(clip), (c) => c.charCodeAt(0));
        const buffer = await context.decodeAudioData(bytes.buffer);
        const destination = context.createMediaStreamDestination();
        (window as unknown as Window_).__say = () =>
          new Promise((resolve) => {
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(destination);
            source.onended = () => resolve();
            source.start();
          });
        return destination.stream;
      };
    },
    { clip: CLIP, refused },
  );
}

const ghost = (page: Page) => page.locator(".dictation-ghost");

/**
 * Holds the dictation key, speaks the clip and releases. `whileListening`
 * runs with the key down once the mic is open; the sentence is still being
 * spoken while it runs, and the key stays down until it returns.
 */
async function dictate(page: Page, whileListening: () => Promise<void> = async () => {}) {
  await page.keyboard.down("ControlRight");
  await page.waitForFunction(() => "__say" in window, undefined, { timeout: 15_000 });
  const speaking = page.evaluate(() => (window as unknown as Window_).__say());
  await whileListening();
  await speaking;
  // Let the last syllable reach the worklet before the key comes up.
  await page.waitForTimeout(400);
  await page.keyboard.up("ControlRight");
}

/** Words stream in while the key is down: the phrase being spoken
 *  shimmers. Needs the model warm — on a cold start the first phrase can
 *  settle before the model is up, and then it shows as plain text. */
async function expectLiveWords(page: Page) {
  await expect(ghost(page).locator(".shimmer")).toHaveText(/\w+/, { timeout: 30_000 });
}

/** Loads the model the way a returning user's app does after startup. */
const warmModel = (page: Page) =>
  page.evaluate(() => (window as unknown as Window_).__notefigCore.dictation.warm());

/** The ::before placeholder text of `el` (or "none"). */
const placeholderOf = (el: Locator) =>
  el.evaluate((node) => getComputedStyle(node, "::before").content);

test.describe("dictation", () => {
  test.setTimeout(120_000);

  test("into a document: wave and live words, then one undoable insert @smoke", async ({ page }) => {
    const workspace = "/workspace/dictation-doc";
    await setupTestDatabase(page, "dictation-doc");
    await fakeMicrophone(page);
    await openWorkspace(page, workspace);
    await seedTestFiles(page, [
      { path: `${workspace}/notes.md`, content: "# Notes\n\nToday:\n", type: "file" },
    ]);
    await page.goto("/?sidebarView=files");
    await waitForFileTree(page, "notes.md");
    await openFileInTree(page, "notes.md");

    const editor = page.locator('.ProseMirror[role="textbox"]').first();
    const today = editor.getByText("Today:");
    // End of the last line. Retried: a freshly opened document's own focus
    // can land late and put the caret back at the top.
    await expect(async () => {
      await today.click();
      await page.keyboard.press("End");
      await page.waitForTimeout(300);
      const caret = await page.evaluate(() => {
        const s = getSelection()!;
        return `${s.anchorNode?.textContent}@${s.anchorOffset}`;
      });
      expect(caret).toBe("Today:@6");
    }).toPass({ timeout: 15_000 });
    await warmModel(page);

    await dictate(page, async () => {
      // The wave shows the moment the key is down, trailing the words.
      await expect(ghost(page).locator("canvas.dictation-wave")).toBeVisible();
      await expectLiveWords(page);
      expect(await editor.textContent()).not.toMatch(SPOKEN);
    });

    await expect(today).toContainText(SPOKEN, { timeout: 60_000 });
    await expect(ghost(page)).toHaveCount(0);
    await page.keyboard.press("Control+Z");
    await expect(editor).not.toContainText(SPOKEN);
    await expect(today).toHaveText("Today:");
  });

  test("into a prompt widget: the hint, then the wave in the harness's place @smoke", async ({
    page,
  }) => {
    await setupTestDatabase(page, "dictation-widget");
    await fakeMicrophone(page);
    await openWorkspace(page, "/workspace/dictation-widget");
    await page.reload();
    // An empty scratchpad gets a prompt widget with the caret in its draft.
    await page.getByRole("button", { name: "New scratchpad" }).click();
    const widget = page.locator('[data-type="ai-prompt"]').locator("visible=true").first();
    const draft = widget.locator("[data-prompt-draft]");
    await expect(draft).toBeVisible();
    await expect.poll(() => placeholderOf(draft)).toContain(HINT);
    await draft.click();

    const picker = widget.getByRole("button", { name: "Choose harness" });
    const logo = picker.locator(".dictation-idle-only");
    const wave = picker.locator("canvas.dictation-active-only");
    await expect(logo).toBeVisible();
    await expect(wave).toBeHidden();

    await dictate(page, async () => {
      await expect(wave).toBeVisible();
      await expect(logo).toBeHidden();
      await expect.poll(() => placeholderOf(draft)).toBe("none");
      // The composer shows its own wave: none inline among the words.
      await expect(ghost(page).locator(".dictation-wave")).toBeHidden();
      // Cold model here: words arrive, live or already settled.
      await expect(ghost(page)).toHaveText(/\w+/, { timeout: 30_000 });
    });

    await expect(draft).toContainText(SPOKEN, { timeout: 60_000 });
    await expect(logo).toBeVisible();
    await expect(wave).toBeHidden();
  });

  test("into the session composer: the wave in the send button @smoke", async ({ page }) => {
    await setupTestDatabase(page, "dictation-chat");
    await fakeMicrophone(page);
    await startMockSession(page, "/workspace/dictation-chat");
    const box = composer(page);
    await expect.poll(() => placeholderOf(box.locator("p"))).toContain(HINT);
    await warmModel(page);
    await box.click();

    const send = page.getByRole("button", { name: "Send" });
    const arrow = send.locator(".dictation-idle-only");
    const wave = send.locator("canvas.dictation-active-only");
    await expect(arrow).toBeVisible();

    await dictate(page, async () => {
      await expect(wave).toBeVisible();
      await expect(arrow).toBeHidden();
      // Disabled (nothing typed yet), but the wave mustn't look it.
      await expect(send).toHaveCSS("opacity", "1");
      await expect.poll(() => placeholderOf(box.locator("p"))).toBe("none");
      await expectLiveWords(page);
    });

    await expect(box).toContainText(SPOKEN, { timeout: 60_000 });
    await expect(arrow).toBeVisible();
    await expect(wave).toBeHidden();
  });

  test("off in settings: no hint, and the key does nothing", async ({ page }) => {
    await setupTestDatabase(page, "dictation-off");
    await fakeMicrophone(page);
    await startMockSession(page, "/workspace/dictation-off");
    await page.evaluate(() =>
      (window as unknown as Window_).__notefigCore.kv.write("settings", "dictationEnabled", false),
    );
    const box = composer(page);
    await expect.poll(() => placeholderOf(box.locator("p"))).not.toContain(HINT);
    await box.click();
    await page.keyboard.down("ControlRight");
    await page.waitForTimeout(1000);
    await expect(ghost(page)).toHaveCount(0);
    await page.keyboard.up("ControlRight");
    expect(await page.evaluate(() => "__say" in window)).toBe(false);
  });

  test("a refused microphone says so and inserts nothing", async ({ page }) => {
    await setupTestDatabase(page, "dictation-refused");
    await fakeMicrophone(page, { refused: true });
    await startMockSession(page, "/workspace/dictation-refused");
    const box = composer(page);
    await box.click();
    await page.keyboard.down("ControlRight");
    await expect(page.getByText("Dictation didn't work")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.up("ControlRight");
    await expect(ghost(page)).toHaveCount(0);
    await expect(box).toHaveText("");
  });
});
