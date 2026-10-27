import { describe, expect, it } from "vitest";
import { greedyCtc, parseTokens } from "./ctc";
import { loadBundledModel, type ModelManifest } from "./load-model";
import { createFft, createLogMel, PARAKEET_FEATURES } from "./log-mel";

/** The O(n²) power spectrum the FFT replaces. */
function naivePowerSpectrum(frame: Float32Array): Float32Array {
  const n = frame.length;
  const out = new Float32Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += frame[i] * Math.cos((2 * Math.PI * k * i) / n);
      im -= frame[i] * Math.sin((2 * Math.PI * k * i) / n);
    }
    out[k] = re * re + im * im;
  }
  return out;
}

describe("log-mel", () => {
  it("computes the same power spectrum as a naive DFT", () => {
    const powerSpectrum = createFft(512);
    const frame = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9));
    const fast = powerSpectrum(frame);
    const slow = naivePowerSpectrum(frame);
    for (let k = 0; k < fast.length; k++) {
      expect(fast[k]).toBeCloseTo(slow[k], 1);
    }
  });

  it("rejects FFT sizes that aren't a power of two", () => {
    expect(() => createFft(400)).toThrow();
  });

  it("produces 80 normalized mels per 10 ms frame", () => {
    const second = Float32Array.from({ length: 16_000 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / 16_000));
    const { features, frames, nMels } = createLogMel()(second);
    expect(nMels).toBe(PARAKEET_FEATURES.nMels);
    expect(frames).toBe(1 + Math.floor((16_000 - 400) / 160));
    const row = features.subarray(0, frames);
    const mean = row.reduce((a, v) => a + v, 0) / frames;
    expect(Math.abs(mean)).toBeLessThan(1e-4);
  });

  it("pads a clip shorter than one window", () => {
    const { frames } = createLogMel()(new Float32Array(100));
    expect(frames).toBe(1);
  });
});

describe("ctc", () => {
  const vocab = parseTokens("<unk> 0\n▁hel 1\nlo 2\n▁world 3\n. 4\n<blk> 5\n");

  /** Log-probs where frame t's best token is `path[t]`. */
  const logprobs = (path: number[]) => {
    const size = vocab.tokens.length;
    const data = new Float32Array(path.length * size).fill(-10);
    path.forEach((id, t) => (data[t * size + id] = 0));
    return data;
  };

  it("reads sherpa tokens and finds the blank", () => {
    expect(vocab.tokens).toEqual(["<unk>", "▁hel", "lo", "▁world", ".", "<blk>"]);
    expect(vocab.blankId).toBe(5);
  });

  it("collapses repeats, drops blanks and joins pieces into words", () => {
    const path = [5, 1, 1, 5, 2, 2, 5, 3, 3, 3, 4, 5];
    expect(greedyCtc(logprobs(path), path.length, vocab)).toBe("hello world.");
  });

  it("keeps a repeated token that a blank separates", () => {
    const path = [2, 5, 2];
    expect(greedyCtc(logprobs(path), path.length, vocab)).toBe("lolo");
  });

  it("drops control tokens", () => {
    const path = [0, 1, 2];
    expect(greedyCtc(logprobs(path), path.length, vocab)).toBe("hello");
  });
});

describe("loadBundledModel", () => {
  const sha = async (bytes: Uint8Array) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");

  async function bundle(overrides: Record<string, Uint8Array | string> = {}) {
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const tokens = new TextEncoder().encode("<blk> 0\n");
    const manifest: ModelManifest = {
      version: "test-1",
      size: 5,
      chunks: await Promise.all(
        chunks.map(async (c, i) => ({ file: `model.00${i}.bin`, size: c.length, sha256: await sha(c) })),
      ),
      tokens: { file: "tokens.txt", sha256: await sha(tokens) },
    };
    const files: Record<string, Uint8Array | string> = {
      "manifest.json": JSON.stringify(manifest),
      "model.000.bin": chunks[0],
      "model.001.bin": chunks[1],
      "tokens.txt": tokens,
      ...overrides,
    };
    const fetcher = (async (url: URL) => {
      const body = files[url.pathname.split("/").pop()!];
      return body === undefined ? new Response("<!doctype html>", { status: 200 }) : new Response(body as BodyInit);
    }) as unknown as typeof fetch;
    return fetcher;
  }

  it("joins the chunks in order and decodes the tokens", async () => {
    const model = await loadBundledModel(new URL("https://app.test/dictation/"), await bundle());
    expect(Array.from(model.bytes)).toEqual([1, 2, 3, 4, 5]);
    expect(model.tokens).toBe("<blk> 0\n");
    expect(model.version).toBe("test-1");
  });

  it("refuses a chunk whose checksum doesn't match", async () => {
    const fetcher = await bundle({ "model.001.bin": new Uint8Array([4, 6]) });
    await expect(loadBundledModel(new URL("https://app.test/dictation/"), fetcher)).rejects.toThrow(
      /checksum mismatch/,
    );
  });

  it("refuses the SPA fallback page in place of a missing chunk", async () => {
    const fetcher = await bundle({ "model.000.bin": undefined as unknown as string });
    await expect(loadBundledModel(new URL("https://app.test/dictation/"), fetcher)).rejects.toThrow(
      /bytes, expected/,
    );
  });
});
