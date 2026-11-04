//! `MarkdownJoiner` (port of `desktop/src/lib/markdown-joiner-transform.ts`):
//! buffers streamed assistant markdown until a safe render boundary, so a
//! chunk sequence like `**`, `bold`, `**` lands as `**bold**`.

#[derive(Debug, Default, Clone)]
pub struct MarkdownJoiner {
    buffer: String,
    document_chars: usize,
    is_buffering: bool,
    streaming_code_block: bool,
    streaming_large_document: bool,
    streaming_table: bool,
}

fn is_complete_bold(buffer: &str) -> bool {
    // /\*\*.*?\*\*/ — `.` excludes newlines.
    let mut search = 0;
    while let Some(start) = buffer[search..].find("**") {
        let open = search + start + 2;
        let rest = &buffer[open..];
        if let Some(close) = rest.find("**")
            && !rest[..close].contains('\n')
        {
            return true;
        }
        search = open - 1;
        if search >= buffer.len() {
            break;
        }
    }
    false
}

fn is_complete_code_block_start(buffer: &str) -> bool {
    // /```[^\s]+/
    let mut search = 0;
    while let Some(i) = buffer[search..].find("```") {
        let after = search + i + 3;
        if buffer[after..]
            .chars()
            .next()
            .is_some_and(|c| !c.is_whitespace())
        {
            return true;
        }
        search = search + i + 1;
    }
    false
}

fn is_complete_link(buffer: &str) -> bool {
    // /^\[.*?\]\(.*?\)$/
    buffer.starts_with('[')
        && buffer.ends_with(')')
        && !buffer.contains('\n')
        && buffer.contains("](")
}

/// After `prefix_len` chars: `\s+.+` (≥1 whitespace, then a non-newline char).
fn ws_then_text(chars: &[char], from: usize) -> bool {
    if chars.get(from).is_none_or(|c| !c.is_whitespace()) {
        return false;
    }
    let mut k = from + 1;
    while k < chars.len() {
        if chars[k] != '\n' {
            return true;
        }
        // '\n' is whitespace: the run may continue.
        k += 1;
    }
    false
}

fn unordered_list(chars: &[char]) -> bool {
    matches!(chars.first(), Some('*' | '-')) && ws_then_text(chars, 1)
}

fn todo_list(chars: &[char]) -> bool {
    // /^[*-]\s+\[[ xX]\]\s+.+/
    if !matches!(chars.first(), Some('*' | '-')) {
        return false;
    }
    let mut i = 1;
    if !chars.get(i).is_some_and(|c| c.is_whitespace()) {
        return false;
    }
    while chars.get(i).is_some_and(|c| c.is_whitespace()) {
        i += 1;
    }
    chars.get(i) == Some(&'[')
        && matches!(chars.get(i + 1), Some(' ' | 'x' | 'X'))
        && chars.get(i + 2) == Some(&']')
        && ws_then_text(chars, i + 3)
}

fn ordered_list(chars: &[char]) -> bool {
    // /^\d+\.\s+.+/
    let digits = chars.iter().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && chars.get(digits) == Some(&'.') && ws_then_text(chars, digits + 1)
}

fn is_complete_mdx_tag(buffer: &str) -> bool {
    // /<([A-Za-z][A-Za-z0-9\-_]*)>/
    let chars: Vec<char> = buffer.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if *c != '<' || !chars.get(i + 1).is_some_and(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        let mut j = i + 2;
        while chars
            .get(j)
            .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        {
            j += 1;
        }
        if chars.get(j) == Some(&'>') {
            return true;
        }
    }
    false
}

impl MarkdownJoiner {
    pub fn new() -> Self {
        Self::default()
    }

    fn clear(&mut self) {
        self.buffer.clear();
        self.is_buffering = false;
    }

    fn is_complete_list(&self) -> bool {
        let chars: Vec<char> = self.buffer.chars().collect();
        if unordered_list(&chars) && self.buffer.contains('[') {
            return todo_list(&chars);
        }
        unordered_list(&chars) || ordered_list(&chars) || todo_list(&chars)
    }

    fn buffer_len(&self) -> usize {
        self.buffer.chars().count()
    }

    fn is_false_positive(&self, c: char) -> bool {
        if self.buffer.starts_with('[') && self.buffer.contains("http") {
            return false;
        }
        c == '\n' || self.buffer_len() > 30
    }

    fn is_table_existed(&self) -> bool {
        self.buffer_len() > 10 && !self.buffer.contains('|')
    }

    /// Everything still buffered (call at a run boundary).
    pub fn flush(&mut self) -> String {
        let remaining = std::mem::take(&mut self.buffer);
        self.clear();
        remaining
    }

    /// Feed a chunk; returns the text that is safe to render now.
    pub fn process_text(&mut self, text: &str) -> String {
        let mut output = String::new();
        for c in text.chars() {
            if self.streaming_code_block || self.streaming_table || self.streaming_large_document {
                self.buffer.push(c);
                if c == '\n' {
                    output.push_str(&self.buffer);
                    self.clear();
                }
                if self.streaming_code_block && self.buffer.trim_end() == "```" {
                    self.streaming_code_block = false;
                    output.push_str(&self.buffer);
                    self.clear();
                }
                if self.streaming_table && self.is_table_existed() {
                    self.streaming_table = false;
                    output.push_str(&self.buffer);
                    self.clear();
                }
            } else if self.is_buffering {
                self.buffer.push(c);
                if is_complete_code_block_start(&self.buffer) {
                    self.streaming_code_block = true;
                    continue;
                }
                if self.buffer.starts_with('|') && self.buffer.ends_with('|') {
                    self.streaming_table = true;
                    continue;
                }
                if self.document_chars > 2500 {
                    self.streaming_large_document = true;
                    continue;
                }
                if is_complete_bold(&self.buffer)
                    || is_complete_mdx_tag(&self.buffer)
                    || self.is_complete_list()
                    || is_complete_link(&self.buffer)
                    || self.is_false_positive(c)
                {
                    output.push_str(&self.buffer);
                    self.clear();
                }
            } else if matches!(c, '*' | '<' | '`' | '|' | '[' | '-') || c.is_ascii_digit() {
                self.buffer = c.to_string();
                self.is_buffering = true;
            } else {
                output.push(c);
            }
        }
        self.document_chars += text.chars().count();
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_bold_across_chunks() {
        let mut j = MarkdownJoiner::new();
        assert_eq!(j.process_text("hi "), "hi ");
        assert_eq!(j.process_text("**"), "");
        assert_eq!(j.process_text("bold"), "");
        assert_eq!(j.process_text("**"), "**bold**");
    }

    #[test]
    fn flush_returns_pending() {
        let mut j = MarkdownJoiner::new();
        assert_eq!(j.process_text("a *b"), "a ");
        assert_eq!(j.flush(), "*b");
        assert_eq!(j.process_text("c"), "c");
    }

    #[test]
    fn newline_releases_false_positive_and_lists() {
        let mut j = MarkdownJoiner::new();
        assert_eq!(j.process_text("2 cats\n"), "2 cats\n");
        assert_eq!(j.process_text("- "), "");
        assert_eq!(j.process_text("item"), "- item");
    }

    #[test]
    fn code_block_streams_line_by_line() {
        let mut j = MarkdownJoiner::new();
        let mut out = j.process_text("```rust\nfn x() {}\n```");
        out.push_str(&j.process_text("\nafter"));
        out.push_str(&j.flush());
        assert_eq!(out, "```rust\nfn x() {}\n```\nafter");
    }
}
