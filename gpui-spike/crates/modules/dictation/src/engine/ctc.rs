//! Port of `engine/ctc.ts`: greedy CTC decoding — the best token per frame,
//! repeats collapsed, blanks dropped, SentencePiece pieces joined (`▁`
//! starts a word). (Originally from onnx-asr-web, MIT.)

#[derive(Debug, Clone, PartialEq)]
pub struct Vocabulary {
    pub tokens: Vec<String>,
    pub blank_id: usize,
}

/// sherpa-onnx `tokens.txt`: one `<piece> <id>` per line.
pub fn parse_tokens(text: &str) -> Vocabulary {
    let mut tokens: Vec<String> = Vec::new();
    for line in text.split('\n') {
        let line = line.trim_end();
        let Some((piece, id)) = line.rsplit_once(' ') else { continue };
        if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Ok(id) = id.parse::<usize>() else { continue };
        if tokens.len() <= id {
            tokens.resize(id + 1, String::new());
        }
        tokens[id] = piece.to_string();
    }
    let blank_id = tokens
        .iter()
        .position(|t| t == "<blk>" || t == "<blank>")
        .unwrap_or(tokens.len().saturating_sub(1));
    Vocabulary { tokens, blank_id }
}

/// `logprobs` is `[frames × vocab]`, frame-major (the model's `[1, T, V]`).
pub fn greedy_ctc(logprobs: &[f32], frames: usize, vocab: &Vocabulary) -> String {
    let size = vocab.tokens.len();
    let mut ids = Vec::new();
    let mut previous = vocab.blank_id;
    for t in 0..frames {
        let mut best = 0;
        let mut best_value = f32::NEG_INFINITY;
        for v in 0..size {
            let value = logprobs[t * size + v];
            if value > best_value {
                best_value = value;
                best = v;
            }
        }
        if best != vocab.blank_id && best != previous {
            ids.push(best);
        }
        previous = best;
    }
    ids.iter()
        .map(|id| vocab.tokens[*id].as_str())
        .filter(|piece| !piece.is_empty() && !(piece.starts_with('<') && piece.ends_with('>')))
        .collect::<String>()
        .replace('▁', " ")
        .trim()
        .to_string()
}
