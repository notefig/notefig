/**
 * Greedy CTC decoding for the dictation model: the best token per frame,
 * repeats collapsed, blanks dropped, SentencePiece pieces joined (`▁` starts
 * a word). Ported from onnx-asr-web (MIT, github.com/SanderGi/onnx-asr-web).
 */

export interface Vocabulary {
  tokens: string[];
  blankId: number;
}

/** sherpa-onnx `tokens.txt`: one `<piece> <id>` per line. */
export function parseTokens(text: string): Vocabulary {
  const tokens: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^(.*) (\d+)$/.exec(line.trimEnd());
    if (match) tokens[Number(match[2])] = match[1];
  }
  const blankId = tokens.findIndex((t) => t === "<blk>" || t === "<blank>");
  return { tokens, blankId: blankId >= 0 ? blankId : tokens.length - 1 };
}

/** `logprobs` is `[frames × vocab]`, frame-major (the model's `[1, T, V]`). */
export function greedyCtc(logprobs: Float32Array, frames: number, vocab: Vocabulary): string {
  const size = vocab.tokens.length;
  const ids: number[] = [];
  let previous = vocab.blankId;
  for (let t = 0; t < frames; t++) {
    let best = 0;
    let bestValue = -Infinity;
    for (let v = 0, o = t * size; v < size; v++) {
      if (logprobs[o + v] > bestValue) {
        bestValue = logprobs[o + v];
        best = v;
      }
    }
    if (best !== vocab.blankId && best !== previous) ids.push(best);
    previous = best;
  }
  return ids
    .map((id) => vocab.tokens[id])
    .filter((piece) => piece && !(piece.startsWith("<") && piece.endsWith(">")))
    .join("")
    .replace(/▁/g, " ")
    .trim();
}
