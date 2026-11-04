//! Screenshots in feedback (`images.ts`). A pasted image sits in the draft
//! as a `blob:` URL; on send, each one the message still shows is encoded
//! and sent as a file beside the markdown, which refers to it as
//! `attachment:<id>`. Code (fenced or inline) is text, never an image.
//!
//! The TS file does this with regexes using named back-references, which
//! Rust's `regex` lacks; this is the same grammar as a small scanner.

/// What the Worker takes per message.
pub const MAX_IMAGES: usize = 3;

pub(crate) struct ImageMatch<'a> {
    pub end: usize,
    pub alt: &'a str,
    pub src: &'a str,
}

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

/// `![alt](blob:… | data:image/…;base64,… "title"?)` at `i`.
pub(crate) fn image_at(s: &str, i: usize) -> Option<ImageMatch<'_>> {
    let b = s.as_bytes();
    if !s[i..].starts_with("![") {
        return None;
    }
    let alt_start = i + 2;
    let alt_end = alt_start + s[alt_start..].find(']')?;
    if b.get(alt_end + 1) != Some(&b'(') {
        return None;
    }
    let src_start = alt_end + 2;
    let rest = &s[src_start..];
    let body_start = if rest.starts_with("blob:") {
        src_start + 5
    } else if let Some(after) = rest.strip_prefix("data:image/") {
        let n = after.bytes().take_while(|c| c.is_ascii_lowercase() || *c == b'+').count();
        if n == 0 || !after[n..].starts_with(";base64,") {
            return None;
        }
        src_start + 11 + n + 8
    } else {
        return None;
    };
    let mut j = body_start;
    while j < b.len() && b[j] != b')' && !is_ws(b[j]) {
        j += 1;
    }
    if j == body_start {
        return None;
    }
    let src_end = j;
    if b.get(j) == Some(&b')') {
        return Some(ImageMatch { end: j + 1, alt: &s[alt_start..alt_end], src: &s[src_start..src_end] });
    }
    // Optional title: \s+"[^"]*"
    while j < b.len() && is_ws(b[j]) {
        j += 1;
    }
    if b.get(j) != Some(&b'"') {
        return None;
    }
    let close = j + 1 + s[j + 1..].find('"')?;
    if b.get(close + 1) != Some(&b')') {
        return None;
    }
    Some(ImageMatch { end: close + 2, alt: &s[alt_start..alt_end], src: &s[src_start..src_end] })
}

/// Fenced code from a line start (`i` is 0 or a newline), or inline code.
fn code_at(s: &str, i: usize) -> Option<usize> {
    let b = s.as_bytes();
    // Fenced: (?:^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\k<fence>[`~]*(?=\n|$)
    let fence_start = if b[i] == b'\n' { Some(i + 1) } else if i == 0 { Some(0) } else { None };
    if let Some(f) = fence_start
        && let Some(&c) = b.get(f)
        && (c == b'`' || c == b'~')
    {
        let n = b[f..].iter().take_while(|x| **x == c).count();
        if n >= 3 {
            let fence = &s[f..f + n];
            if let Some(nl) = s[f + n..].find('\n') {
                let body = f + n + nl + 1;
                let mut k = body;
                loop {
                    let Some(off) = s[k..].find('\n') else { break };
                    let at = k + off;
                    if s[at + 1..].starts_with(fence) {
                        let mut e = at + 1 + n;
                        while e < b.len() && (b[e] == b'`' || b[e] == b'~') {
                            e += 1;
                        }
                        if e == b.len() || b[e] == b'\n' {
                            return Some(e);
                        }
                    }
                    k = at + 1;
                }
            }
        }
    }
    // Inline: (`+)[^`][\s\S]*?\k<ticks>
    if b[i] == b'`' {
        let n = b[i..].iter().take_while(|x| **x == b'`').count();
        let after = i + n;
        if after < b.len() {
            let ticks = &s[i..after];
            let first = s[after..].chars().next()?;
            let from = after + first.len_utf8();
            if let Some(off) = s[from..].find(ticks) {
                return Some(from + off + n);
            }
        }
    }
    None
}

/// `markdown` with `edit` applied to everything outside its code.
pub(crate) fn outside_code(markdown: &str, mut edit: impl FnMut(&str) -> String) -> String {
    let mut result = String::new();
    let mut last = 0;
    let mut i = 0;
    while i < markdown.len() {
        if !markdown.is_char_boundary(i) {
            i += 1;
            continue;
        }
        if let Some(m) = image_at(markdown, i) {
            i = m.end;
            continue;
        }
        if let Some(end) = code_at(markdown, i) {
            result += &edit(&markdown[last..i]);
            result += &markdown[i..end];
            last = end;
            i = end;
            continue;
        }
        i += 1;
    }
    result + &edit(&markdown[last..])
}

/// Every image in `text`, with a replacement.
pub(crate) fn replace_images(text: &str, mut with: impl FnMut(&ImageMatch) -> String) -> String {
    let mut out = String::new();
    let mut last = 0;
    let mut i = 0;
    while i < text.len() {
        if text.is_char_boundary(i) && let Some(m) = image_at(text, i) {
            out += &text[last..i];
            out += &with(&m);
            last = m.end;
            i = m.end;
            continue;
        }
        i += 1;
    }
    out + &text[last..]
}

/// The message's length as the Worker counts it: an image by its
/// placeholder, not the bytes a data URL carries. In UTF-16 units, as JS.
pub fn message_length(markdown: &str) -> usize {
    outside_code(markdown, |text| replace_images(text, |m| format!("![{}](attachment:img0)", m.alt)))
        .encode_utf16()
        .count()
}

pub(crate) fn decode_base64(data: &str) -> Vec<u8> {
    let val = |c: u8| -> Option<u32> {
        Some(match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32)
    };
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0);
    for c in data.bytes().filter_map(val) {
        acc = (acc << 6) | c;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// `data:image/png;base64,…` → (mime, bytes).
pub(crate) fn data_url_bytes(url: &str) -> (String, Vec<u8>) {
    let (header, data) = url.split_once(',').unwrap_or((url, ""));
    let mime = header.trim_start_matches("data:").split(';').next().unwrap_or("").to_string();
    (mime, decode_base64(data))
}
