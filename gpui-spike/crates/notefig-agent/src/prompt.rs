//! Prompt composition: `composePrompt`, `placeCommands`, the widget-context
//! URI codec, and the leading-quote convention (ports of
//! `shared/src/agent/prompt-composer.ts`, `harness-adapters/adapter.ts`,
//! `agent/src/widget-context-uri.ts`, `agents.ts`).

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextPartKind {
    /// A `resource_link` block (widget context URI, `file://` mention).
    ResourceLink,
    /// An embedded `resource` block, degrading to fenced text when the
    /// harness doesn't advertise `embeddedContext`.
    Embedded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptContextPart {
    pub kind: ContextPartKind,
    /// URI (resource_link) or path (embedded).
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A command or skill a prompt runs (`@skill:x`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptCommand {
    pub name: String,
}

/// A session setting switched to right before the prompt's turn, by category.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptConfigChange {
    pub category: String,
    pub value: String,
}

/// What a prompt carries besides its text.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PromptExtras {
    #[serde(default)]
    pub context_parts: Vec<PromptContextPart>,
    #[serde(default)]
    pub commands: Vec<PromptCommand>,
    #[serde(default)]
    pub config: Vec<PromptConfigChange>,
}

/// The ACP content blocks for a prompt.
pub fn compose_prompt(
    text: &str,
    parts: &[PromptContextPart],
    embedded_context: bool,
) -> Vec<Value> {
    let mut blocks = vec![json!({"type": "text", "text": text})];
    for part in parts {
        match part.kind {
            ContextPartKind::ResourceLink => blocks.push(json!({
                "type": "resource_link",
                "uri": part.path,
                "name": part.name.clone().unwrap_or_else(|| part.path.clone()),
            })),
            ContextPartKind::Embedded if embedded_context => blocks.push(json!({
                "type": "resource",
                "resource": {"uri": part.path, "text": part.content.clone().unwrap_or_default()},
            })),
            ContextPartKind::Embedded => blocks.push(json!({
                "type": "text",
                "text": format!("\n\n```{}\n{}\n```\n", part.path, part.content.clone().unwrap_or_default()),
            })),
        }
    }
    blocks
}

/// The blocks with the first text block's text rewritten (inserting one
/// if there is none).
pub fn with_first_text(blocks: Vec<Value>, rewrite: impl FnOnce(&str) -> String) -> Vec<Value> {
    let index = blocks
        .iter()
        .position(|b| b.get("type").and_then(Value::as_str) == Some("text"));
    match index {
        None => {
            let mut out = vec![json!({"type": "text", "text": rewrite("").trim()})];
            out.extend(blocks);
            out
        }
        Some(index) => {
            let mut blocks = blocks;
            let text = blocks[index]
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            blocks[index]["text"] = Value::String(rewrite(&text));
            blocks
        }
    }
}

/// Place a prompt's commands: the first runs as the harness's own command
/// where its adapter puts it (`placer`, default: `/name ` at the start of
/// the first text block); further ones are asked for in words.
pub fn place_commands(
    blocks: Vec<Value>,
    commands: &[PromptCommand],
    placer: Option<&dyn Fn(Vec<Value>, &str) -> Vec<Value>>,
) -> Vec<Value> {
    let Some((first, rest)) = commands.split_first() else {
        return blocks;
    };
    let asked = if rest.is_empty() {
        blocks
    } else {
        let also = rest
            .iter()
            .map(|c| format!("Also use the `{}` skill.", c.name))
            .collect::<Vec<_>>()
            .join(" ");
        with_first_text(blocks, |text| format!("{text}\n\n{also}"))
    };
    match placer {
        Some(place) => place(asked, &first.name),
        None => with_first_text(asked, |text| format!("/{} {text}", first.name)),
    }
}

/// Split a leading markdown blockquote (the quoted passage a widget prompt
/// opens with) off the prompt.
pub fn split_leading_quote(text: &str) -> (Option<String>, String) {
    let lines: Vec<&str> = text.split('\n').collect();
    let end = lines.iter().take_while(|l| l.starts_with('>')).count();
    if end == 0 {
        return (None, text.to_string());
    }
    let strip = |l: &str| {
        l.strip_prefix("> ")
            .or_else(|| l.strip_prefix('>'))
            .unwrap_or(l)
            .to_string()
    };
    let quote = lines[..end]
        .iter()
        .map(|l| strip(l))
        .collect::<Vec<_>>()
        .join("\n");
    let rest = lines[end..].join("\n").trim_start_matches('\n').to_string();
    (Some(quote), rest)
}

/// The task title a first prompt gives (minus a leading quote, ≤60 chars).
pub fn title_from_prompt(text: &str) -> String {
    let (_, rest) = split_leading_quote(text);
    let named = if rest.trim().is_empty() {
        text.to_string()
    } else {
        rest.trim().to_string()
    };
    if named.chars().count() > 60 {
        format!("{}…", named.chars().take(57).collect::<String>())
    } else {
        named
    }
}

// ─── Widget context URI ─────────────────────────────────────────────────────

pub const WIDGET_CONTEXT_SCHEME: &str = "notefig://widget-context";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub from: i64,
    pub to: i64,
}

/// What `resources/read` needs to rebuild a widget's context bundle; fully
/// encoded in the URI, so nothing is stored server-side.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetContextRef {
    /// Workspace-relative document path.
    pub path: String,
    /// Editor position at send time.
    pub pos: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_range: Option<Range>,
}

fn form_encode(value: &str) -> String {
    let mut out = String::new();
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn form_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("zz");
                match u8::from_str_radix(hex, 16) {
                    Ok(byte) => {
                        out.push(byte);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn encode_widget_context_uri(r: &WidgetContextRef) -> String {
    let mut query = format!("path={}&pos={}", form_encode(&r.path), r.pos);
    if let Some(range) = r.selected_range {
        query.push_str(&format!("&from={}&to={}", range.from, range.to));
    }
    format!("{WIDGET_CONTEXT_SCHEME}?{query}")
}

pub fn decode_widget_context_uri(uri: &str) -> Option<WidgetContextRef> {
    let query = uri.strip_prefix(WIDGET_CONTEXT_SCHEME)?.strip_prefix('?')?;
    let mut path = None;
    let mut pos = None;
    let mut from = None;
    let mut to = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = form_decode(value);
        match key {
            "path" => path = Some(value),
            "pos" => pos = value.parse::<f64>().ok(),
            "from" => from = value.parse::<f64>().ok(),
            "to" => to = value.parse::<f64>().ok(),
            _ => {}
        }
    }
    let path = path.filter(|p| !p.is_empty())?;
    Some(WidgetContextRef {
        path,
        pos: pos?.round() as i64,
        selected_range: match (from, to) {
            (Some(from), Some(to)) => Some(Range {
                from: from as i64,
                to: to as i64,
            }),
            _ => None,
        },
    })
}

/// Where an in-document widget prompt comes from (`promptFromWidget`).
#[derive(Debug, Clone, PartialEq)]
pub struct WidgetPromptSource {
    pub workspace_path: String,
    /// Workspace-relative document path.
    pub path: String,
    pub pos: i64,
    pub is_doc_empty: bool,
    /// The selected passage the prompt is about (text + editor range).
    pub reference: Option<(String, Range)>,
}

/// The prompt text + extras a widget send turns into: an empty doc gets an
/// inline framing; otherwise the referenced passage leads as a blockquote
/// and a widget-context `resource_link` rides along.
pub fn widget_prompt(
    text: &str,
    source: &WidgetPromptSource,
    mut extras: PromptExtras,
) -> (String, PromptExtras) {
    if source.is_doc_empty {
        let framing = format!(
            "{} is currently empty. Author directly into it — do not just describe what you would write. When finished, deliver a brief confirmation (or any issues) via the `widget_respond` tool, not as plain chat text.\n\n",
            source.path
        );
        return (framing + text, extras);
    }
    let uri = encode_widget_context_uri(&WidgetContextRef {
        path: source.path.clone(),
        pos: source.pos,
        selected_range: source.reference.as_ref().map(|(_, r)| *r),
    });
    let quoted = match &source.reference {
        Some((quote, _)) => format!(
            "{}\n\n{text}",
            quote
                .split('\n')
                .map(|l| format!("> {l}"))
                .collect::<Vec<_>>()
                .join("\n")
        ),
        None => text.to_string(),
    };
    let mut parts = vec![PromptContextPart {
        kind: ContextPartKind::ResourceLink,
        path: uri,
        content: None,
        name: None,
    }];
    parts.append(&mut extras.context_parts);
    extras.context_parts = parts;
    (quoted, extras)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_degrades_to_fenced_text() {
        let parts = vec![PromptContextPart {
            kind: ContextPartKind::Embedded,
            path: "a.md".into(),
            content: Some("x".into()),
            name: None,
        }];
        let blocks = compose_prompt("hi", &parts, false);
        assert_eq!(blocks[1]["type"], "text");
        assert!(
            blocks[1]["text"]
                .as_str()
                .unwrap()
                .contains("```a.md\nx\n```")
        );
        let blocks = compose_prompt("hi", &parts, true);
        assert_eq!(blocks[1]["type"], "resource");
    }

    #[test]
    fn commands_placed_first_and_rest_asked_for() {
        let blocks = compose_prompt("do it", &[], false);
        let cmds = vec![
            PromptCommand { name: "a".into() },
            PromptCommand { name: "b".into() },
        ];
        let placed = place_commands(blocks, &cmds, None);
        assert_eq!(placed[0]["text"], "/a do it\n\nAlso use the `b` skill.");
    }

    #[test]
    fn widget_uri_round_trips() {
        let r = WidgetContextRef {
            path: "dir/a b&c.md".into(),
            pos: 42,
            selected_range: Some(Range { from: 1, to: 9 }),
        };
        let uri = encode_widget_context_uri(&r);
        assert_eq!(decode_widget_context_uri(&uri), Some(r));
        assert!(decode_widget_context_uri("file:///x").is_none());
    }

    #[test]
    fn leading_quote_split_and_title() {
        let (q, rest) = split_leading_quote("> one\n> two\n\nfix this");
        assert_eq!(q.as_deref(), Some("one\ntwo"));
        assert_eq!(rest, "fix this");
        assert_eq!(title_from_prompt("> q\n\nhello"), "hello");
        assert_eq!(title_from_prompt(&"x".repeat(70)).chars().count(), 58);
    }
}
