/**
 * Measuring in the page, so Playwright's own round trips never land in a
 * number.
 *
 * A keystroke's latency is input to next paint: from the keydown's
 * `timeStamp` (when the browser received the input) to a task posted from
 * the next animation frame, which runs once that frame has been painted.
 * The listener sits on `window` in the capture phase, ahead of every app
 * handler, so whatever the app does with the key — and the layout and
 * paint it causes — is inside the measurement.
 *
 * Every sample is tagged with the scenario current at keydown; a long
 * task (≥ 50 ms on the main thread) with the scenario current when it
 * started. The observer delivers long tasks late, so the probe keeps the
 * history of labels to look that up.
 */
import { promises as fs } from "node:fs";
import type { Page } from "@playwright/test";

export interface PerfSamples {
  /** Scenario → latencies in ms. */
  latency: Record<string, number[]>;
  /** Scenario → durations of the long tasks seen while it ran. */
  longTasks: Record<string, number[]>;
}

interface PerfProbe extends PerfSamples {
  label: string | null;
  /** Tag what follows as `label` (null: record nothing). */
  setLabel(label: string | null): void;
}

declare global {
  interface Window {
    __perf: PerfProbe;
    __perfAction: Promise<number>;
  }
}

function install(): void {
  const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);
  const history: { at: number; label: string | null }[] = [];
  const probe: PerfProbe = {
    label: null,
    latency: {},
    longTasks: {},
    setLabel(label) {
      probe.label = label;
      history.push({ at: performance.now(), label });
    },
  };
  const labelAt = (time: number) =>
    history.findLast((entry) => entry.at <= time)?.label ?? null;
  window.__perf = probe;
  const push = (into: Record<string, number[]>, label: string, ms: number) =>
    (into[label] ??= []).push(ms);
  window.addEventListener(
    "keydown",
    (event) => {
      const label = probe.label;
      // Control+A is one keystroke: its Control keydown isn't a sample.
      if (label === null || MODIFIERS.has(event.key)) return;
      const start = event.timeStamp;
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () =>
          push(probe.latency, label, performance.now() - start);
        channel.port2.postMessage(null);
      });
    },
    { capture: true },
  );
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const label = labelAt(entry.startTime);
      if (label !== null) push(probe.longTasks, label, entry.duration);
    }
  }).observe({ type: "longtask", buffered: false });
}

/** Install the probe; call before the page loads. */
export async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(install);
}

/** Tag what follows as `label` (null: record nothing). */
export async function setLabel(
  page: Page,
  label: string | null,
): Promise<void> {
  await page.evaluate((next) => window.__perf.setLabel(next), label);
}

/** Everything recorded so far. */
export function readSamples(page: Page): Promise<PerfSamples> {
  return page.evaluate(() => ({
    latency: window.__perf.latency,
    longTasks: window.__perf.longTasks,
  }));
}

/**
 * Run `body` as scenario `label`, then let the tail drain (the last
 * frame's sample, a debounced save) before anything else is tagged.
 */
export async function scenario(
  page: Page,
  label: string,
  body: () => Promise<void>,
): Promise<void> {
  await setLabel(page, label);
  await body();
  await page.waitForTimeout(1000);
  await setLabel(page, null);
}

/**
 * The gap between two keystrokes: about a fast typist's pace. Sending
 * keys back to back would queue them and measure the queue.
 */
export const KEY_INTERVAL_MS = 80;

/** One keystroke, then the gap before the next. */
export async function stroke(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await page.waitForTimeout(KEY_INTERVAL_MS);
}

/**
 * What an action is done showing: a visible element matching `selector`,
 * holding `text` when given (or no text at all, with `empty`), and holding
 * focus when `focused` is set.
 */
export interface Shown {
  selector: string;
  text?: string;
  empty?: boolean;
  focused?: boolean;
}

/** In the page: arm one sample, input (keydown or pointerdown) → the first
 *  painted frame that shows `shown`, as `window.__perfAction`. Waits first
 *  for `shown` to leave the screen (the last round's dialog still closing):
 *  armed while it shows, the first frame after any input would pass and
 *  the sample would time nothing. False when it never leaves. */
async function armAction(args: {
  label: string;
  shown: Shown;
}): Promise<boolean> {
  const { label, shown } = args;
  const MODIFIERS = new Set(["Control", "Shift", "Alt", "Meta"]);
  const showing = () =>
    Array.from(document.querySelectorAll<HTMLElement>(shown.selector)).some(
      (el) =>
        el.checkVisibility({ visibilityProperty: true }) &&
        (shown.text === undefined ||
          (el.textContent ?? "").includes(shown.text)) &&
        (!shown.empty || (el.textContent ?? "") === "") &&
        (!shown.focused || el.contains(document.activeElement)),
    );
  const gone = performance.now() + 10_000;
  while (showing()) {
    if (performance.now() > gone) return false;
    await new Promise(requestAnimationFrame);
  }
  window.__perfAction = new Promise((resolve, reject) => {
    const onInput = (event: Event) => {
      if (event instanceof KeyboardEvent && MODIFIERS.has(event.key)) return;
      window.removeEventListener("keydown", onInput, true);
      window.removeEventListener("pointerdown", onInput, true);
      const start = event.timeStamp;
      window.__perf.setLabel(label);
      // Checked in each frame's rAF, after the frame's DOM work and before
      // its paint: the first frame that passes is the one that shows it.
      const check = () =>
        requestAnimationFrame(() => {
          if (!showing()) {
            if (performance.now() - start > 30_000)
              reject(new Error(`${label}: never showed ${shown.selector}`));
            else check();
            return;
          }
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            const ms = performance.now() - start;
            (window.__perf.latency[label] ??= []).push(ms);
            resolve(ms);
          };
          channel.port2.postMessage(null);
        });
      check();
    };
    window.addEventListener("keydown", onInput, true);
    window.addEventListener("pointerdown", onInput, true);
  });
  return true;
}

/**
 * One sample of an action: `input` (a key press, a click) to the first
 * painted frame that shows `shown`. The long tasks it causes are tagged
 * `label` too, through the settling tail as well as up to that frame:
 * work an action leaves for after its first paint is still its own.
 */
export async function action(
  page: Page,
  label: string,
  shown: Shown,
  input: () => Promise<void>,
): Promise<number> {
  if (!(await page.evaluate(armAction, { label, shown })))
    throw new Error(`${label}: ${shown.selector} never left before the input`);
  try {
    await input();
    const ms = await page.evaluate(() => window.__perfAction);
    await page.waitForTimeout(500);
    return ms;
  } finally {
    // Even for a missed sample: what follows (cleanup keys, the next
    // action's input) must not land under this label.
    await setLabel(page, null);
  }
}

/**
 * One autosave sample: press `key`, in the editor of `file`, and time it
 * to the file being rewritten (its mtime), in ms. Timed from here rather
 * than in the page, whose probe can't see the disk; the press's own round
 * trip (a few ms) is in it, against a 500 ms debounce. Throws when the
 * file isn't written, so a dead autosave fails the run.
 */
export async function autosave(
  page: Page,
  file: string,
  key: string,
): Promise<number> {
  const before = (await fs.stat(file)).mtimeMs;
  const start = Date.now();
  await page.keyboard.press(key);
  let written = before;
  while (written <= before) {
    if (Date.now() - start > 10_000)
      throw new Error(`autosave: ${file} not written after ${key}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    written = (await fs.stat(file)).mtimeMs;
  }
  // Let the tail of the save settle before the next keystroke.
  await page.waitForTimeout(KEY_INTERVAL_MS);
  return written - start;
}
