/**
 * Push-to-talk dictation (`core.dictation`): hold the dictation key, talk,
 * release, and the words land at the caret of whichever editor has focus.
 *
 * Editors offer themselves through the dictation extension
 * (`@notefig/widgets`, `attach`); this service owns the rest — the hold key,
 * the microphone, and the bundled speech model in a worker. Nothing leaves
 * the device.
 *
 * Text streams while the speaker talks. Speech is split at their pauses;
 * each finished phrase is decoded once and settles. In between, whenever the
 * worker is free, the phrase still being spoken is decoded again from its
 * start, so the editor shows it growing (shimmering, since it can still
 * change). Releasing the key only waits for the last phrase.
 */
import { toast } from "sonner";
import {
  detectPlatform,
  KeyStateTracker,
  MAC_MODIFIER_SYMBOLS,
  STANDARD_MODIFIER_LABELS,
} from "@tanstack/react-hotkeys";
import { defineModule } from "@notefig/core";
import {
  fitDictation,
  type DictationHost,
  type DictationInsertion,
  type DictationTarget,
} from "@notefig/widgets";
import { kvModule } from "@/modules/kv";
import i18n from "@/utils/intl";
import { openBrowserMicrophone, type Microphone, type OpenMicrophone } from "./microphone";
import { createSegmenter, DEFAULT_SEGMENTER } from "./segmenter";
import { createWorkerEngine, type DictationEngine } from "./worker-engine";

export type DictationStatus = "idle" | "starting" | "listening" | "finishing" | "error";

export interface DictationState {
  status: DictationStatus;
  /** Why the last dictation failed, while `status` is "error". */
  error?: string;
}

export type DictationHoldKey = "AltRight" | "ControlRight";

export interface DictationApi extends DictationHost {
  readonly holdKey: DictationHoldKey;
  state(): DictationState;
  subscribe(listener: () => void): () => void;
  /** Key down: starts listening into the focused attached editor, if any. */
  press(): Promise<void>;
  /** Key up: decodes what's left and inserts the text. */
  release(): Promise<void>;
  /** Escape: drops this dictation; nothing is inserted. */
  cancel(): void;
  /** Loads the model ahead of the first press; resolves once it's ready. */
  warm(): Promise<void>;
  /** Follows the hold key (TanStack's key state tracker) and Escape. */
  listen(): () => void;
}

export interface DictationDeps {
  engine: DictationEngine;
  openMicrophone: OpenMicrophone;
  /** The user's setting; read at each key press. */
  enabled: () => Promise<boolean>;
  /** Called after each dictation that inserted text. */
  onDictated?: () => void;
  holdKey: DictationHoldKey;
  /** How long the mic stays open after a dictation, for a quick follow-up. */
  warmMs?: number;
}

declare module "@notefig/core" {
  interface CoreModules {
    dictation: DictationApi;
  }
}

const ms = (n: number) => (DEFAULT_SEGMENTER.sampleRate * n) / 1000;
/** Speech from before the key went down that's kept, while the mic is warm. */
const PREROLL_SAMPLES = ms(300);
/** A tail shorter than this after release is silence, not worth decoding. */
const MIN_TAIL_SAMPLES = ms(300);
/** The live phrase is first decoded at this length, then after each step. */
const MIN_LIVE_SAMPLES = ms(300);
const LIVE_STEP_SAMPLES = ms(250);
/** A speaker this quiet after new words gets a guess at once, so the guess
 *  is usually complete by the time they let go of the key. */
const SETTLE_QUIET_MS = 150;

type Platform = ReturnType<typeof detectPlatform>;

/** The modifier each hold key is the right-hand one of. */
const MODIFIER = { AltRight: "Alt", ControlRight: "Control" } as const;

/** Right ⌥ on a Mac; Right Ctrl elsewhere, where Right Alt is AltGr on many layouts. */
export function dictationHoldKey(platform: Platform = detectPlatform()): DictationHoldKey {
  return platform === "mac" ? "AltRight" : "ControlRight";
}

/** The hold key as people read it, in TanStack's symbols: "right ⌥", "right Ctrl". */
export function holdKeyLabel(key: DictationHoldKey, platform: Platform = detectPlatform()): string {
  const modifier = MODIFIER[key];
  return `right ${platform === "mac" ? MAC_MODIFIER_SYMBOLS[modifier] : STANDARD_MODIFIER_LABELS[modifier]}`;
}

const hasWords = (text: string) => /[\p{L}\p{N}]/u.test(text);

/**
 * Joins phrases decoded one by one as if they had been one sentence. A
 * phrase that came back as bare punctuation (a breath, a click) is dropped,
 * and a period before a phrase the model began in lowercase was the cut's,
 * not the speaker's: the model ends every clip it hears with one.
 */
export function joinPhrases(phrases: string[]): string {
  return phrases
    .filter(hasWords)
    .reduce((text, phrase) => {
      const base = /^[a-z]/.test(phrase.trim()) ? text.replace(/\.$/, "") : text;
      return base + fitDictation(base, "", phrase);
    }, "")
    .trim();
}

/** Microphone loudness as the wave shows it: -55 dBFS (room) to -15 (loud). */
function loudness(samples: Float32Array): number {
  let energy = 0;
  for (const s of samples) energy += s * s;
  const db = 10 * Math.log10(energy / Math.max(1, samples.length) + 1e-12);
  return Math.min(1, Math.max(0, (db + 55) / 40));
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Splits a live guess for display: the words it shares with the guess
 * before it have held still and read as plain text; only the words still
 * changing shimmer (at least the last one, while the phrase goes on). Less
 * moving text is calmer to read and cheaper to paint.
 */
export function splitGuess(previous: string, text: string): { steady: string; changing: string } {
  const before = previous.split(" ");
  const words = text.split(" ");
  let same = 0;
  while (same < words.length - 1 && words[same] === before[same]) same++;
  return { steady: words.slice(0, same).join(" "), changing: words.slice(same).join(" ") };
}

/**
 * One dictation, key down to key up: cuts phrases at pauses and decodes
 * them in order, slips live guesses at the phrase in progress in between,
 * and joins the result. Decodes run one after another, as the worker does,
 * so guesses back off to leave it room: each waits at least half again as
 * long as the last one took.
 */
function createRun(insertion: DictationInsertion, engine: DictationEngine) {
  const segmenter = createSegmenter();
  const phrases: string[] = [];
  let decoding = Promise.resolve();
  /** Phrases cut so far: a live guess started before the latest cut is stale. */
  let cuts = 0;
  let queued = 0;
  let guessing = false;
  let sinceGuess = 0;
  let guessGap = LIVE_STEP_SAMPLES;
  /** The latest guess at the phrase in progress, and how much audio it heard. */
  let lastGuess: { text: string; raw: string; heard: number; at: number } | null = null;
  /** `releasing` from key up; `released` once the mic's last audio is in. */
  const run = { releasing: false, released: false, cancelled: false, error: null as unknown };
  const open = () => !run.released && !run.cancelled && !run.error;
  /** Guesses stop at key up: the final decode is next. */
  const mayGuess = () => open() && !run.releasing;

  const queue = (job: () => Promise<void>) => {
    decoding = decoding.then(job);
  };

  /** A cut phrase; `preview: false` for the last one, committed next. */
  const decodePhrase = (samples: Float32Array, preview = true) => {
    cuts++;
    queued++;
    queue(async () => {
      try {
        if (run.cancelled || run.error) return;
        const text = await engine.transcribe(samples);
        if (run.cancelled) return;
        phrases.push(text);
        // The settled phrase takes the live guess's place in one update.
        if (preview && hasWords(text)) insertion.preview(joinPhrases(phrases), "");
      } catch (error) {
        run.error = error;
      } finally {
        queued--;
      }
    });
  };

  /** The speaker has paused after words the last guess didn't hear. */
  const paused = () =>
    segmenter.quietMs() >= SETTLE_QUIET_MS &&
    segmenter.speechAfter(lastGuess?.at === cuts ? lastGuess.heard : 0);

  /** The phrase still being spoken, again from its start, when the worker is free. */
  const guess = () => {
    if (!mayGuess() || guessing || queued > 0) return;
    if (sinceGuess < guessGap && !paused()) return;
    const audio = segmenter.peek();
    if (audio.length < MIN_LIVE_SAMPLES || !segmenter.hasSpeech()) return;
    const at = cuts;
    sinceGuess = 0;
    guessing = true;
    queue(async () => {
      try {
        // A guess still waiting when the key comes up is skipped.
        if (!mayGuess()) return;
        const started = performance.now();
        const raw = await engine.transcribe(audio);
        // The model ends whatever it hears with a period; mid-phrase that's
        // only where the audio stopped so far.
        const text = raw.replace(/\.$/, "");
        guessGap = Math.max(LIVE_STEP_SAMPLES, ms(1.5 * (performance.now() - started)));
        // Shown words are only ever replaced by other words: a guess that
        // came back empty (a breath, a lone ".") leaves the last one up, so
        // nothing blinks out and back.
        if (run.cancelled || cuts !== at || !hasWords(text)) return;
        const { steady, changing } = splitGuess(lastGuess?.at === at ? lastGuess.text : "", text);
        lastGuess = { text, raw, heard: audio.length, at };
        if (open()) insertion.preview(joinPhrases([...phrases, steady]), changing);
      } catch {
        // A failed guess isn't a failed dictation: the phrase decode of the
        // same audio reports it if the model is really down.
      } finally {
        guessing = false;
      }
    });
  };

  return Object.assign(run, {
    insertion,
    hear(samples: Float32Array) {
      if (!open()) return;
      sinceGuess += samples.length;
      for (const phrase of segmenter.push(samples)) decodePhrase(phrase);
      guess();
    },
    /**
     * Decodes what's left and resolves with the whole text. When the last
     * guess already heard all of the speech in the final phrase (the
     * speaker stopped, then let go), it is that phrase: decoding the same
     * audio again would only make the release wait.
     */
    async finish(): Promise<string> {
      await decoding;
      const guessed = lastGuess?.at === cuts ? lastGuess : null;
      const fresh = guessed ? segmenter.speechAfter(guessed.heard) : segmenter.hasSpeech();
      const tail = segmenter.flush();
      if (guessed && !fresh) phrases.push(guessed.raw);
      else if (fresh && tail.length >= MIN_TAIL_SAMPLES) decodePhrase(tail, false);
      await decoding;
      if (run.error) throw run.error;
      return joinPhrases(phrases);
    },
  });
}

type Run = ReturnType<typeof createRun>;

export function createDictation(deps: DictationDeps): DictationApi {
  const { engine, holdKey, warmMs = 30_000 } = deps;
  const targets = new Set<DictationTarget>();
  const listeners = new Set<() => void>();
  let state: DictationState = { status: "idle" };
  let run: Run | null = null;
  let opening: Promise<void> = Promise.resolve();
  let mic: Promise<Microphone> | null = null;
  let micClose: ReturnType<typeof setTimeout> | null = null;
  let preroll: Float32Array[] = [];
  let level = 0;

  const setState = (next: DictationState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  const closeMic = () => {
    const closing = mic;
    mic = null;
    preroll = [];
    void closing?.then((m) => m.close(), () => {});
  };

  const onAudio = (samples: Float32Array) => {
    if (run && !run.released && !run.cancelled) {
      level = loudness(samples);
      run.hear(samples);
      return;
    }
    preroll.push(samples);
    let kept = preroll.reduce((n, s) => n + s.length, 0);
    while (preroll.length > 1 && kept - preroll[0].length >= PREROLL_SAMPLES) {
      kept -= preroll.shift()!.length;
    }
  };

  const openMic = () => {
    if (micClose) clearTimeout(micClose);
    micClose = null;
    if (!mic) {
      const pending = deps.openMicrophone().then((m) => {
        m.onAudio(onAudio);
        return m;
      });
      mic = pending;
      pending.catch(() => {
        if (mic === pending) mic = null;
      });
    }
    return mic;
  };

  /** Ends `current`, if it's still the dictation in progress. */
  /** Closes the mic once it has gone unused for `warmMs` — never under a
   *  dictation in progress. */
  const closeLater = () => {
    if (micClose) clearTimeout(micClose);
    micClose = setTimeout(() => {
      if (!run) closeMic();
    }, warmMs);
  };

  /** Everything the mic heard up to now, in: its last batch is still in
   *  the worklet when the key comes up. */
  const flushMic = async () => {
    const open = await mic?.catch(() => null);
    if (open) await Promise.race([open.flush(), new Promise((r) => setTimeout(r, 150))]);
  };

  const end = (current: Run, error?: unknown) => {
    if (run !== current) return;
    run = null;
    level = 0;
    if (error === undefined) {
      closeLater();
      setState({ status: "idle" });
    } else {
      current.insertion.cancel();
      closeMic();
      setState({ status: "error", error: message(error) });
    }
  };

  const start = async (current: Run) => {
    const enabled = await deps.enabled();
    // Cancelled meanwhile: `end` already ran, and no mic is open.
    if (current.cancelled) return;
    if (!enabled) {
      current.cancelled = true;
      current.insertion.cancel();
      return end(current);
    }
    // The model loads alongside the mic; the first decode waits for it.
    engine.load().catch(() => {});
    try {
      await openMic();
    } catch (error) {
      return end(current, error);
    }
    // Cancelled while it opened: opening cleared the close `end` set up.
    // (Unless a newer dictation has the mic now.)
    if (current.cancelled) {
      if (!run) closeLater();
      return;
    }
    const heard = preroll;
    preroll = [];
    heard.forEach(onAudio);
    if (!current.released) setState({ status: "listening" });
  };

  const api: DictationApi = {
    holdKey,

    attach(target) {
      targets.add(target);
      return () => {
        targets.delete(target);
      };
    },

    level: () => level,
    state: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async press() {
      if (run) return;
      const insertion = [...targets].find((t) => t.hasFocus())?.begin();
      if (!insertion) return;
      const current = createRun(insertion, engine);
      run = current;
      setState({ status: "starting" });
      opening = start(current);
      await opening;
    },

    async release() {
      const current = run;
      if (!current || current.releasing || current.cancelled) return;
      current.releasing = true;
      setState({ status: "finishing" });
      await opening;
      if (run !== current || current.cancelled) return;
      await flushMic();
      current.released = true;
      level = 0;
      try {
        const text = await current.finish();
        if (current.cancelled) return;
        current.insertion.commit(text);
        end(current);
        if (text) deps.onDictated?.();
      } catch (error) {
        end(current, error);
      }
    },

    cancel() {
      const current = run;
      if (!current) return;
      current.cancelled = true;
      current.insertion.cancel();
      end(current);
    },

    warm: () => engine.load().catch(() => {}),

    listen() {
      // Held is "the modifier is down, by its right-hand key". The tracker
      // also lets go of everything when the window loses focus.
      const tracker = KeyStateTracker.getInstance();
      let held = false;
      const holding = tracker.store.subscribe(() => {
        const now = tracker.store.state.heldCodes[MODIFIER[holdKey]] === holdKey;
        if (now === held) return;
        held = now;
        void (now ? api.press() : api.release());
      });
      // Escape isn't a hold. Captured, so it cancels the dictation before a
      // composer's own Escape (which would stop a running agent turn).
      const onEscape = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || !run) return;
        event.preventDefault();
        event.stopPropagation();
        api.cancel();
      };
      window.addEventListener("keydown", onEscape, true);
      return () => {
        holding.unsubscribe();
        window.removeEventListener("keydown", onEscape, true);
        api.cancel();
        if (micClose) clearTimeout(micClose);
        closeMic();
      };
    },
  };
  return api;
}

/**
 * The user's switch lives in the app settings namespace
 * (hooks/use-app-settings.ts), read here directly so this module doesn't
 * pull the React hook in. `dictationUsed` is this module's own: someone who
 * has dictated before gets the model loaded ahead of their next press.
 */
const SETTINGS = "settings";

export const dictationModule = defineModule({
  name: "dictation",
  needs: [kvModule],
  register: (ctx) => {
    const kv = ctx.use("kv");
    return createDictation({
      engine: createWorkerEngine(new URL(import.meta.env.BASE_URL, window.location.origin).href),
      openMicrophone: openBrowserMicrophone,
      enabled: async () => (await kv.read<boolean>(SETTINGS, "dictationEnabled")) ?? true,
      onDictated: () => void kv.write(SETTINGS, "dictationUsed", true),
      holdKey: dictationHoldKey(),
    });
  },
  boot: (dictation, ctx) => {
    const stopListening = dictation.listen();
    // A failed dictation inserts nothing, so say why (most often a refused
    // microphone permission).
    const stopReporting = dictation.subscribe(() => {
      const { status, error } = dictation.state();
      if (status === "error") toast.error(i18n.t("dictationFailed", { reason: error }));
    });
    // Warm once the app has settled, so it never competes with startup.
    const warming = setTimeout(async () => {
      const kv = ctx.use("kv");
      const used = await kv.read<boolean>(SETTINGS, "dictationUsed");
      const enabled = (await kv.read<boolean>(SETTINGS, "dictationEnabled")) ?? true;
      if (used && enabled) dictation.warm();
    }, 5_000);
    return () => {
      clearTimeout(warming);
      stopReporting();
      stopListening();
    };
  },
});
