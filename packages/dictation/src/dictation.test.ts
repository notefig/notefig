import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDictation,
  dictationHoldKey,
  holdKeyLabel,
  joinPhrases,
  splitGuess,
  type DictationApi,
  type DictationEngine,
} from "./dictation";
import type { Microphone } from "./microphone";
import { createResampler } from "./microphone";
import { createSegmenter } from "./segmenter";
import type { DictationInsertion, DictationTarget } from "./target";

const RATE = 16_000;
const speech = (ms: number) =>
  Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => 0.2 * Math.sin(i * 0.3));
const silence = (ms: number) => new Float32Array((RATE * ms) / 1000);
/** Short phrases, for segmenter tests that shouldn't need minutes of audio. */
const SHORT = { sampleRate: RATE, pauseMs: 400, minPhraseMs: 2000, maxPhraseMs: 5000 };

function fakeMic() {
  let listener: ((s: Float32Array) => void) | null = null;
  const mic: Microphone & { closed: boolean } = {
    closed: false,
    onAudio(l) {
      listener = l;
      return () => (listener = null);
    },
    flush: async () => {},
    close() {
      mic.closed = true;
    },
  };
  return { mic, say: (samples: Float32Array) => listener?.(samples) };
}

function fakeTarget(focused = true) {
  const events: string[] = [];
  const insertion: DictationInsertion = {
    preview: (settled, live) => events.push(`preview:${settled}|${live}`),
    commit: (text) => events.push(`commit:${text}`),
    cancel: () => events.push("cancel"),
  };
  const target: DictationTarget = { hasFocus: () => focused, begin: () => insertion };
  return { target, events };
}

describe("dictation", () => {
  let heard: string[];
  let engine: DictationEngine & { transcribe: ReturnType<typeof vi.fn> };
  let microphone: ReturnType<typeof fakeMic>;
  let enabled: boolean;
  let dictation: DictationApi;
  let onDictated: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    heard = [];
    enabled = true;
    onDictated = vi.fn();
    microphone = fakeMic();
    engine = {
      load: vi.fn(async () => {}),
      transcribe: vi.fn(async () => heard.shift() ?? ""),
    };
    dictation = createDictation({
      engine,
      openMicrophone: async () => microphone.mic,
      enabled: async () => enabled,
      onDictated,
      holdKey: "ControlRight",
      warmMs: 50,
    });
  });

  afterEach(() => vi.useRealTimers());

  it("inserts what was said into the focused editor on release", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    heard = ["Ship it."];

    await dictation.press();
    expect(dictation.state().status).toBe("listening");
    microphone.say(speech(1000));
    await dictation.release();

    expect(events.at(-1)).toBe("commit:Ship it.");
    expect(onDictated).toHaveBeenCalledOnce();
    expect(dictation.state().status).toBe("idle");
  });

  it("decodes phrases at pauses while talking and joins them on release", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    // The cut phrase is ~4.76 s (speech plus half the pause); live guesses
    // and the tail are shorter.
    let cut = false;
    engine.transcribe.mockImplementation(async (samples: Float32Array) => {
      if (!cut && samples.length > 4.6 * RATE) {
        cut = true;
        return "We should refactor";
      }
      return cut ? "The extension." : "We should";
    });

    await dictation.press();
    microphone.say(speech(4500));
    microphone.say(silence(700));
    await vi.waitFor(() => expect(events).toContain("preview:We should refactor|"));
    microphone.say(speech(1500));
    await dictation.release();

    expect(events.at(-1)).toBe("commit:We should refactor the extension.");
  });

  it("streams the phrase being spoken as live text before it settles", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    engine.transcribe.mockImplementation(async (samples: Float32Array) =>
      samples.length < RATE ? "We" : "We should",
    );

    await dictation.press();
    microphone.say(speech(600));
    await vi.waitFor(() => expect(events).toContain("preview:|We"));
    microphone.say(speech(600));
    // "We" held still between guesses, so it reads plain; "should" shimmers.
    await vi.waitFor(() => expect(events).toContain("preview:We|should"));
    await dictation.release();
    expect(events.at(-1)).toBe("commit:We should");
  });

  it("keeps the shown words when a guess comes back empty", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    const guesses = ["We", "", ".", "We should"];
    engine.transcribe.mockImplementation(async () => guesses.shift() ?? "We should");

    await dictation.press();
    for (let i = 0; i < 4; i++) {
      microphone.say(speech(300));
      await vi.waitFor(() => expect(engine.transcribe).toHaveBeenCalledTimes(i + 1));
    }
    await vi.waitFor(() => expect(events).toContain("preview:We|should"));
    expect(events.filter((e) => e.startsWith("preview:"))).toEqual(["preview:|We", "preview:We|should"]);
    dictation.cancel();
  });

  it("lets go straight to the last guess when nothing was said after it", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    engine.transcribe.mockResolvedValue("Ship it.");

    await dictation.press();
    microphone.say(speech(1000));
    await vi.waitFor(() => expect(events).toContain("preview:|Ship it"));
    microphone.say(silence(300));
    const calls = engine.transcribe.mock.calls.length;
    await dictation.release();
    // No second decode of the same speech: the guess, as the model wrote it.
    expect(engine.transcribe.mock.calls.length).toBe(calls);
    expect(events.at(-1)).toBe("commit:Ship it.");
  });

  it("decodes the rest on release when there was speech after the last guess", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    engine.transcribe.mockImplementation(async (samples: Float32Array) =>
      samples.length > 1.5 * RATE ? "Ship it today." : "Ship it",
    );

    await dictation.press();
    microphone.say(speech(1000));
    await vi.waitFor(() => expect(events).toContain("preview:|Ship it"));
    // Too soon for another guess, so only the release hears these words.
    microphone.say(speech(150));
    microphone.say(speech(700));
    await dictation.release();
    expect(events.at(-1)).toBe("commit:Ship it today.");
  });

  it("drops a live guess that a phrase cut has overtaken", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    let finishLive: (text: string) => void = () => {};
    engine.transcribe
      .mockImplementationOnce(() => new Promise<string>((resolve) => (finishLive = resolve)))
      .mockResolvedValueOnce("Settled phrase.")
      .mockResolvedValue("");

    await dictation.press();
    microphone.say(speech(4500));
    await vi.waitFor(() => expect(engine.transcribe).toHaveBeenCalledTimes(1));
    microphone.say(silence(700));
    finishLive("stale guess");
    await dictation.release();
    expect(events).not.toContain("preview:|stale guess");
    expect(events.at(-1)).toBe("commit:Settled phrase.");
  });

  it("reports the mic's loudness while listening, and silence after", async () => {
    const { target } = fakeTarget();
    dictation.attach(target);
    await dictation.press();
    microphone.say(silence(100));
    expect(dictation.level()).toBe(0);
    microphone.say(speech(100));
    expect(dictation.level()).toBeGreaterThan(0.5);
    await dictation.release();
    expect(dictation.level()).toBe(0);
  });

  it("does nothing when no attached editor has focus", async () => {
    const { target, events } = fakeTarget(false);
    dictation.attach(target);
    await dictation.press();
    expect(dictation.state().status).toBe("idle");
    expect(events).toEqual([]);
  });

  it("stops offering an editor once it detaches", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target)();
    await dictation.press();
    expect(events).toEqual([]);
  });

  it("drops the dictation on cancel", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    heard = ["never mind"];
    await dictation.press();
    microphone.say(speech(300));
    dictation.cancel();
    await dictation.release();
    expect(events).toEqual(["cancel"]);
    expect(engine.transcribe).not.toHaveBeenCalled();
  });

  it("is a no-op while the setting is off", async () => {
    enabled = false;
    const { target, events } = fakeTarget();
    dictation.attach(target);
    await dictation.press();
    expect(events).toEqual(["cancel"]);
    expect(dictation.state().status).toBe("idle");
  });

  it("reports a refused microphone and recovers on the next press", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    let refuse = true;
    dictation = createDictation({
      engine,
      openMicrophone: async () => {
        if (refuse) throw new Error("Permission denied");
        return microphone.mic;
      },
      enabled: async () => true,
      holdKey: "ControlRight",
    });
    dictation.attach(target);
    await dictation.press();
    expect(dictation.state()).toEqual({ status: "error", error: "Permission denied" });
    expect(events).toEqual(["cancel"]);

    refuse = false;
    await dictation.press();
    expect(dictation.state().status).toBe("listening");
  });

  it("cancels instead of inserting when the model fails", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    engine.transcribe.mockRejectedValueOnce(new Error("model failed"));
    await dictation.press();
    microphone.say(speech(1000));
    await dictation.release();
    expect(events).toEqual(["cancel"]);
    expect(dictation.state()).toEqual({ status: "error", error: "model failed" });
  });

  it("closes the mic when a dictation is cancelled while it starts", async () => {
    vi.useFakeTimers();
    const { target } = fakeTarget();
    let settingRead: (on: boolean) => void = () => {};
    let opened = 0;
    dictation = createDictation({
      engine,
      openMicrophone: async () => {
        opened++;
        return microphone.mic;
      },
      enabled: () => new Promise((resolve) => (settingRead = resolve)),
      holdKey: "ControlRight",
      warmMs: 50,
    });
    dictation.attach(target);
    const pressing = dictation.press();
    dictation.cancel();
    settingRead(true);
    await pressing;
    await vi.advanceTimersByTimeAsync(60);
    // Never opened, or opened and closed again: not left open.
    expect(opened === 0 || microphone.mic.closed).toBe(true);
    expect(dictation.state().status).toBe("idle");
  });

  it("keeps the mic for a dictation started while a cancelled one was opening it", async () => {
    vi.useFakeTimers();
    const first = fakeTarget();
    let micOpens: (() => void)[] = [];
    dictation = createDictation({
      engine,
      openMicrophone: () => new Promise((resolve) => micOpens.push(() => resolve(microphone.mic))),
      enabled: async () => true,
      holdKey: "ControlRight",
      warmMs: 50,
    });
    dictation.attach(first.target);
    const cancelled = dictation.press();
    await vi.advanceTimersByTimeAsync(0);
    dictation.cancel();
    const second = dictation.press();
    await vi.advanceTimersByTimeAsync(0);
    micOpens.forEach((open) => open());
    micOpens = [];
    await Promise.all([cancelled, second]);
    await vi.advanceTimersByTimeAsync(200);
    expect(dictation.state().status).toBe("listening");
    expect(microphone.mic.closed).toBe(false);
    dictation.cancel();
  });

  it("waits for the mic's last batch before finishing", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    engine.transcribe.mockImplementation(async (samples: Float32Array) =>
      samples.length > 0.9 * RATE ? "Every word." : "Every",
    );
    microphone.mic.flush = async () => microphone.say(speech(500));
    await dictation.press();
    microphone.say(speech(600));
    await dictation.release();
    expect(events.at(-1)).toBe("commit:Every word.");
  });

  it("keeps the mic warm briefly after a dictation, then closes it", async () => {
    vi.useFakeTimers();
    const { target } = fakeTarget();
    dictation.attach(target);
    await dictation.press();
    await dictation.release();
    expect(microphone.mic.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(microphone.mic.closed).toBe(true);
  });

  it("follows the right-hand hold key: down, up, and Escape", async () => {
    const { target, events } = fakeTarget();
    dictation.attach(target);
    const stop = dictation.listen();
    heard = ["Hello."];
    const key = (type: string, code: string, key = "Control") =>
      document.dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true }));

    // The left-hand Ctrl is just Ctrl.
    key("keydown", "ControlLeft");
    await Promise.resolve();
    expect(dictation.state().status).toBe("idle");
    key("keyup", "ControlLeft");

    key("keydown", "ControlRight");
    await vi.waitFor(() => expect(dictation.state().status).toBe("listening"));
    microphone.say(speech(1000));
    key("keyup", "ControlRight");
    await vi.waitFor(() => expect(events.at(-1)).toBe("commit:Hello."));

    key("keydown", "ControlRight");
    await vi.waitFor(() => expect(dictation.state().status).toBe("listening"));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(events.at(-1)).toBe("cancel");
    key("keyup", "ControlRight");
    stop();
  });
});

describe("hold key", () => {
  it("is Right ⌥ on macOS and Right Ctrl elsewhere, named in TanStack's symbols", () => {
    expect(dictationHoldKey("mac")).toBe("AltRight");
    expect(dictationHoldKey("windows")).toBe("ControlRight");
    expect(dictationHoldKey("linux")).toBe("ControlRight");
    expect(holdKeyLabel("AltRight", "mac")).toBe("right ⌥");
    expect(holdKeyLabel("ControlRight", "windows")).toBe("right Ctrl");
  });
});

describe("splitGuess", () => {
  it("keeps the words two guesses agree on steady, and the rest changing", () => {
    expect(splitGuess("We should ship", "We should shop the")).toEqual({ steady: "We should", changing: "shop the" });
  });

  it("keeps the last word changing even when nothing moved", () => {
    expect(splitGuess("We should", "We should")).toEqual({ steady: "We", changing: "should" });
    expect(splitGuess("", "We")).toEqual({ steady: "", changing: "We" });
  });
});

describe("joinPhrases", () => {
  it("joins phrases into one sentence where no sentence ended", () => {
    expect(joinPhrases(["So the plan", "Is to ship.", "Then rest."])).toBe("So the plan is to ship. Then rest.");
  });

  it("drops the period a cut left mid-sentence", () => {
    expect(joinPhrases(["We want it to feel instant.", "which means fast."])).toBe(
      "We want it to feel instant which means fast.",
    );
  });

  it("drops a phrase that is only punctuation", () => {
    expect(joinPhrases(["Ship it today.", "."])).toBe("Ship it today.");
  });
});

describe("segmenter", () => {
  it("cuts a phrase in the middle of a long enough pause", () => {
    const segmenter = createSegmenter(SHORT);
    expect(segmenter.push(speech(2500))).toEqual([]);
    const [phrase] = segmenter.push(silence(500));
    expect(phrase.length / RATE).toBeCloseTo(2.5 + 0.2, 1);
    // The pause's second half plus the 100 ms heard after the cut.
    expect(segmenter.flush().length / RATE).toBeCloseTo(0.3, 1);
  });

  it("doesn't decode a silent tail after the last phrase", async () => {
    const segmenter = createSegmenter(SHORT);
    segmenter.push(speech(2500));
    segmenter.push(silence(500));
    expect(segmenter.hasSpeech()).toBe(false);
    segmenter.push(speech(300));
    expect(segmenter.hasSpeech()).toBe(true);
  });

  it("doesn't cut a short phrase or silence alone", () => {
    const segmenter = createSegmenter(SHORT);
    expect(segmenter.push(speech(800))).toEqual([]);
    expect(segmenter.push(silence(600))).toEqual([]);
    const quiet = createSegmenter(SHORT);
    expect(quiet.push(silence(3000))).toEqual([]);
  });

  it("lets a long silence go at the limit instead of cutting it as a phrase", () => {
    const segmenter = createSegmenter(SHORT);
    expect(segmenter.push(silence(6000))).toEqual([]);
    expect(segmenter.hasSpeech()).toBe(false);
    expect(segmenter.peek().length / RATE).toBeLessThan(2);
  });

  it("cuts a phrase that runs on past the limit at its quietest recent moment", () => {
    const segmenter = createSegmenter({ sampleRate: RATE, pauseMs: 400, minPhraseMs: 2000, maxPhraseMs: 5000 });
    // A 100 ms dip between "words" 4 s in, too short to be a pause.
    expect(segmenter.push(speech(4000))).toEqual([]);
    expect(segmenter.push(silence(100))).toEqual([]);
    const [phrase] = segmenter.push(speech(1000));
    // Cut inside the dip, not at the 5 s mark mid-"word".
    expect(phrase.length / RATE).toBeGreaterThanOrEqual(4.0);
    expect(phrase.length / RATE).toBeLessThanOrEqual(4.1);
  });
});

describe("resampler", () => {
  it("turns 48 kHz into 16 kHz across frame boundaries", () => {
    const resample = createResampler(48_000);
    const out = [resample(new Float32Array(128).fill(0.5)), resample(new Float32Array(128).fill(0.5))];
    const total = out.reduce((n, o) => n + o.length, 0);
    expect(total).toBe(Math.floor(256 / 3));
    expect(out[1][0]).toBeCloseTo(0.5);
  });

  it("handles frames of any size, as the worklet batches them", () => {
    const resample = createResampler(48_000);
    expect(resample(new Float32Array(4096)).length + resample(new Float32Array(1)).length).toBe(1365);
  });

  it("handles 44.1 kHz", () => {
    const resample = createResampler(44_100);
    expect(resample(new Float32Array(44_100)).length).toBeGreaterThanOrEqual(15_999);
  });
});
