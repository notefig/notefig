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
import {
  composer,
  loadRecording,
  openDocument,
  promptTextOf,
  replayRecording,
  sendWidgetPrompt,
  startMockSession,
  summonWidget,
} from "../agent/agent-helpers";

const here = dirname(fileURLToPath(import.meta.url));
/** "We should ship the dictation feature today, and review it tomorrow."
 *  (macOS `say`, 16 kHz mono, ~3.8 s) */
const CLIP = readFileSync(join(here, "fixtures", "dictation.wav")).toString("base64");
// Not the first word: where the fake mic's stream starts shifts by a few
// milliseconds between runs, and the model has heard "Sip" for "Ship".
const SPOKEN = /dictation feature today/i;
const HINT = "or hold right Ctrl to talk";

/** What the specs reach on the page: the stand-in mic, and the app's core. */
type Window_ = Window & {
  __say: () => Promise<void>;
  /** The AudioContexts the app made (the mic's), and the streams it got. */
  __appContexts: AudioContext[];
  __streams: MediaStream[];
  __notefigCore: {
    kv: { write(namespace: string, key: string, value: unknown): Promise<void> };
    dictation: { warm(): Promise<void> };
  };
};

/**
 * Replaces the microphone with one that plays CLIP on `__say()`, or one
 * the user refused. `dead`: the app's audio never runs (its AudioContext
 * stays suspended), as when the webview won't start audio.
 */
async function fakeMicrophone(page: Page, { refused = false, dead = false } = {}) {
  await page.addInitScript(
    ({ clip, refused, dead }) => {
      const w = window as unknown as Window_;
      const Native = window.AudioContext;
      w.__appContexts = [];
      w.__streams = [];
      window.AudioContext = class extends Native {
        constructor(options?: AudioContextOptions) {
          super(options);
          w.__appContexts.push(this);
          if (dead) {
            void this.suspend();
            this.resume = () => new Promise(() => {});
          }
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        if (refused) throw new DOMException("Permission denied", "NotAllowedError");
        const context = new Native();
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
        w.__streams.push(destination.stream);
        return destination.stream;
      };
    },
    { clip: CLIP, refused, dead },
  );
}

const ghost = (page: Page) => page.locator(".dictation-ghost");

/**
 * Holds the dictation key, speaks the clip and releases. `whileListening`
 * runs with the key down once the mic is open; the sentence is still being
 * spoken while it runs, and the key stays down until it returns.
 */
async function dictate(
  page: Page,
  whileListening: () => Promise<void> = async () => {},
  { freshMic = false } = {},
) {
  const streams = await page.evaluate(() => (window as unknown as Window_).__streams?.length ?? 0);
  await page.keyboard.down("ControlRight");
  // A fresh mic: speak into the one the app opens now, not the last one.
  await page.waitForFunction(
    (fresh) => "__say" in window && (!fresh || (window as unknown as Window_).__streams.length > fresh),
    freshMic ? streams : 0,
    { timeout: 15_000 },
  );
  const speaking = page.evaluate(() => (window as unknown as Window_).__say());
  await whileListening();
  await speaking;
  // Let the last syllable reach the worklet before the key comes up.
  await page.waitForTimeout(400);
  await page.keyboard.up("ControlRight");
}

/** Words stream in while the key is down, muted until they're committed. */
async function expectLiveWords(page: Page) {
  await expect(ghost(page)).toHaveText(/\w+/, { timeout: 30_000 });
  await expect(ghost(page)).toHaveClass(/text-muted-foreground/);
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
      const wave = ghost(page).locator("svg.dictation-wave");
      await expect(wave).toBeVisible();
      // Five bars, moving.
      const bars = wave.locator("rect");
      await expect(bars).toHaveCount(5);
      const middle = () => bars.nth(2).getAttribute("height");
      const first = await middle();
      await expect.poll(middle, { timeout: 2_000 }).not.toBe(first);
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
    const wave = picker.locator("svg.dictation-active-only");
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

  test("into a prompt widget's reply: the wave in the answer's harness logo", async ({ page }) => {
    await setupTestDatabase(page, "dictation-reply");
    await fakeMicrophone(page);
    const editor = await openDocument(page, "/workspace/dictation-reply", "notes.md", "para one\n");
    const recording = loadRecording("widget-answer.json");
    await replayRecording(page, recording);
    const widget = await summonWidget(page, editor);
    await sendWidgetPrompt(page, widget, promptTextOf(recording, 0));
    await expect(widget.locator("[data-blob-phase]")).toHaveAttribute("data-blob-phase", "done", {
      timeout: 30_000,
    });
    const draft = widget.locator("[data-prompt-draft]");
    await draft.click();

    const mark = widget.locator("[data-widget-response] .dictation-swap").first();
    const logo = mark.locator(".dictation-idle-only");
    const wave = mark.locator("svg.dictation-active-only");
    await expect(logo).toBeVisible();
    await expect(wave).toBeHidden();

    await dictate(page, async () => {
      await expect(wave).toBeVisible();
      await expect(logo).toBeHidden();
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
    const wave = send.locator("svg.dictation-active-only");
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

  // A mic kept open between dictations can go bad without saying so: the
  // webview interrupts its audio while the app is in the background, or
  // the system takes the device. The next dictation must not trust it.
  for (const [breakage, breakMic, freshMic] of [
    [
      // It's asked to run again. (Pressed while still suspended, the mic
      // is replaced instead, as for an ended track.)
      "its audio was suspended",
      async () => {
        const contexts = (window as unknown as Window_).__appContexts;
        await Promise.all(contexts.map((c) => c.suspend()));
        while (contexts.some((c) => c.state !== "running")) await new Promise((r) => setTimeout(r, 20));
      },
      false,
    ],
    [
      // It's replaced.
      "its track ended",
      () => (window as unknown as Window_).__streams.forEach((s) => s.getTracks().forEach((t) => t.stop())),
      true,
    ],
  ] as const) {
    test(`the next dictation still hears you when the warm mic's ${breakage.slice(4)}`, async ({ page }) => {
      await setupTestDatabase(page, "dictation-stale");
      await fakeMicrophone(page);
      await startMockSession(page, "/workspace/dictation-stale");
      await warmModel(page);
      const box = composer(page);
      await box.click();
      await dictate(page);
      const said = async () => ((await box.textContent()) ?? "").match(/feature today/gi)?.length ?? 0;
      // Landed (not only previewed): the next press starts a new dictation.
      await expect(ghost(page)).toHaveCount(0, { timeout: 60_000 });
      expect(await said()).toBe(1);

      await page.evaluate(breakMic);
      await dictate(page, undefined, { freshMic });
      await expect(ghost(page)).toHaveCount(0, { timeout: 60_000 });
      expect(await said()).toBe(2);
    });
  }

  test("a mic that sends no sound says so", async ({ page }) => {
    await setupTestDatabase(page, "dictation-dead");
    await fakeMicrophone(page, { dead: true });
    await startMockSession(page, "/workspace/dictation-dead");
    const box = composer(page);
    await box.click();
    await page.keyboard.down("ControlRight");
    await expect(page.getByText("The microphone isn't sending any sound")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.up("ControlRight");
    await expect(ghost(page)).toHaveCount(0);
    await expect(box).toHaveText("");
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
