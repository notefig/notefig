import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationInsertion, DictationTarget } from "@notefig/widgets";
import {
  createDictation,
  dictationHoldKey,
  holdKeyLabel,
  joinPhrases,
  type DictationApi,
} from "./dictation";
import type { Microphone } from "./microphone";
import { createResampler } from "./microphone";
import { createSegmenter } from "./segmenter";
import type { DictationEngine } from "./worker-engine";

const RATE = 16_000;
const speech = (ms: number) =>
  Float32Array.from({ length: (RATE * ms) / 1000 }, (_, i) => 0.2 * Math.sin(i * 0.3));
const silence = (ms: number) => new Float32Array((RATE * ms) / 1000);

function fakeMic() {
  let listener: ((s: Float32Array) => void) | null = null;
  const mic: Microphone & { closed: boolean } = {
    closed: false,
    onAudio(l) {
      listener = l;
      return () => (listener = null);
    },
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
    // The cut phrase is 2.7 s (speech plus half the pause); live guesses
    // and the tail are shorter.
    let cut = false;
    engine.transcribe.mockImplementation(async (samples: Float32Array) => {
      if (!cut && samples.length > 2.6 * RATE) {
        cut = true;
        return "We should refactor";
      }
      return cut ? "The extension." : "We should";
    });

    await dictation.press();
    microphone.say(speech(2500));
    microphone.say(silence(600));
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
    await vi.waitFor(() => expect(events).toContain("preview:|We should"));
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
    await vi.waitFor(() => expect(events).toContain("preview:|We should"));
    expect(events.filter((e) => e.startsWith("preview:"))).toEqual(["preview:|We", "preview:|We should"]);
    dictation.cancel();
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
    microphone.say(speech(2500));
    await vi.waitFor(() => expect(engine.transcribe).toHaveBeenCalledTimes(1));
    microphone.say(silence(600));
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

describe("joinPhrases", () => {
  it("joins phrases into one sentence where no sentence ended", () => {
    expect(joinPhrases(["So the plan", "Is to ship.", "Then rest."])).toBe("So the plan is to ship. Then rest.");
  });

  it("drops a phrase that is only punctuation", () => {
    expect(joinPhrases(["Ship it today.", "."])).toBe("Ship it today.");
  });
});

describe("segmenter", () => {
  it("cuts a phrase in the middle of a long enough pause", () => {
    const segmenter = createSegmenter();
    expect(segmenter.push(speech(2500))).toEqual([]);
    const [phrase] = segmenter.push(silence(500));
    expect(phrase.length / RATE).toBeCloseTo(2.5 + 0.2, 1);
    // The pause's second half plus the 100 ms heard after the cut.
    expect(segmenter.flush().length / RATE).toBeCloseTo(0.3, 1);
  });

  it("doesn't decode a silent tail after the last phrase", async () => {
    const segmenter = createSegmenter();
    segmenter.push(speech(2500));
    segmenter.push(silence(500));
    expect(segmenter.hasSpeech()).toBe(false);
    segmenter.push(speech(300));
    expect(segmenter.hasSpeech()).toBe(true);
  });

  it("doesn't cut a short phrase or silence alone", () => {
    const segmenter = createSegmenter();
    expect(segmenter.push(speech(800))).toEqual([]);
    expect(segmenter.push(silence(600))).toEqual([]);
    const quiet = createSegmenter();
    expect(quiet.push(silence(3000))).toEqual([]);
  });

  it("cuts a phrase that runs on past the limit", () => {
    const segmenter = createSegmenter({ sampleRate: RATE, pauseMs: 400, minPhraseMs: 2000, maxPhraseMs: 5000 });
    expect(segmenter.push(speech(5000))).toHaveLength(1);
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

  it("handles 44.1 kHz", () => {
    const resample = createResampler(44_100);
    expect(resample(new Float32Array(44_100)).length).toBeGreaterThanOrEqual(15_999);
  });
});
