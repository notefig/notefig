//! The app's MCP tools (ports of `desktop/src/modules/agents/tools/*` and
//! `shared/src/agent/widget-response.ts`): names, titles, descriptions,
//! input JSON Schemas, validation, and the steering instructions text
//! (`mcp-instructions.ts`), all verbatim.

use serde_json::{Map, Value, json};

pub const WIDGET_RESPOND_TOOL_NAME: &str = "widget_respond";

pub struct ToolSpec {
    pub name: &'static str,
    /// English title (the i18n key resolved).
    pub title: &'static str,
    pub description: String,
    pub input_schema: Value,
    pub requires_permission: bool,
}

/// `WIDGET_RESPONSE_KINDS`: (kind, when to use it, awaits a reply).
pub const WIDGET_RESPONSE_KINDS: &[(&str, &str, bool)] = &[
    (
        "answer",
        "your response to the request — the default",
        false,
    ),
    (
        "issue",
        "a blocker or problem you hit and couldn't resolve",
        false,
    ),
    (
        "single_choice",
        "the request has readings that lead to different results, or a decision shapes much of the work, and neither the widget context nor the document settles it. Ask before doing the work it decides (do the parts that don't depend on it), not after; don't ask what the document answers or about a small edit the user can undo. Put the question in `markdown` and concrete outcomes in `options`, the one you'd pick first, no \"Other\" (the user can type their own). Never ask the user in an answer's prose; their pick arrives as your next prompt",
        true,
    ),
    (
        "multiple_choice",
        "like single_choice, when the `options` are independent additions the user may want any number of, not alternatives",
        true,
    ),
];

pub const WIDGET_LIMIT_TITLE: usize = 80;
pub const WIDGET_LIMIT_QUESTION: usize = 200;
pub const WIDGET_LIMIT_OPTION: usize = 60;

const DIFF_FENCE_ABSENT: &str = r"^(?![\s\S]*(?:^|\n) {0,3}(?:`{3,}|~{3,})[ \t]*[^\s`]+(?:[ \t]+[^\s`]+)*?[ \t]+diff(?:[ \t][^\n]*)?(?:\n|$))";

const DIFF_BLOCK_GUIDE: &str = "To show a change to code or text (one you propose, or a before and after), write a diff block, in chat or in a document: a fenced code block whose info string is the language followed by `diff` (```ts diff), holding a unified diff of one file as `git diff` prints it: the `---` and `+++` lines naming the file (`--- /dev/null` for a new one), then `@@ -start,count +start,count @@` hunks of context, `-` and `+` lines, numbered from where those lines are in the file (read it first), not from 1. Notefig draws it as a diff with the file's name. Use one block per file, keep to the lines around the change, and prefer it to two separate code blocks or a plain ```diff block. Answering a prompt widget, put the diff block in the document, where the change belongs, not in `widget_respond`: the widget is too small to read a diff in. Its response then says where the diff is.";

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
        "$schema": "http://json-schema.org/draft-07/schema#",
    })
}

fn empty_schema() -> Value {
    json!({"type": "object", "properties": {}, "additionalProperties": false, "$schema": "http://json-schema.org/draft-07/schema#"})
}

fn describe_response_kinds() -> String {
    WIDGET_RESPONSE_KINDS
        .iter()
        .map(|(kind, used, _)| format!("\"{kind}\" — {used}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// The tool registry, in registry order.
pub fn tool_registry() -> Vec<ToolSpec> {
    let path = json!({"type": "string", "minLength": 1});
    let pos_int = json!({"type": "integer", "exclusiveMinimum": 0});
    let nonneg_int = json!({"type": "integer", "minimum": 0});
    vec![
        ToolSpec {
            name: "workspace_list_documents",
            title: "List Documents",
            description: "List every document in the workspace (path, type, title). Title is the filename for now.".into(),
            input_schema: empty_schema(),
            requires_permission: false,
        },
        ToolSpec {
            name: "workspace_read_document",
            title: "Read Document",
            description: "Read a workspace document's content by path. Optional 1-based `line` + `limit` for a partial read. If this turn's prompt carries a widget-context resource_link, read that first via resources/read — only reach for this tool (or a full, unbounded read) when that resource's outline and surrounding text don't cover what you need.".into(),
            input_schema: object_schema(json!({"path": path, "line": pos_int, "limit": pos_int}), &["path"]),
            requires_permission: false,
        },
        ToolSpec {
            name: "document_read_range",
            title: "Read Document Range",
            description: "Read a workspace document's content between two ProseMirror positions `from` and `to` — the SAME coordinate space as the widget-context resource's `selectedRange` and `position`. Use it to re-read a prompt's referenced passage or a wider window around it: pass the range from `selectedRange` as-is, or pad it outward for more surrounding context. Positions are clamped to the document; the result echoes the effective range and the document's total size so you can page further.".into(),
            input_schema: object_schema(json!({"path": path, "from": nonneg_int, "to": nonneg_int}), &["path", "from", "to"]),
            requires_permission: false,
        },
        ToolSpec {
            name: "workspace_open_files",
            title: "Open Files",
            description: "What the user currently has open: tabs, the active file, and whether there's a selection.".into(),
            input_schema: empty_schema(),
            requires_permission: false,
        },
        ToolSpec {
            name: "history_log",
            title: "Document History",
            description: "List document-history checkpoints (most recent first), optionally scoped to one file's path.".into(),
            input_schema: object_schema(json!({"path": path}), &[]),
            requires_permission: false,
        },
        ToolSpec {
            name: "history_diff",
            title: "Compare Versions",
            description: "Read a document's content at two checkpoints so the agent can compare them.".into(),
            input_schema: object_schema(
                json!({"path": path, "from": {"type": "string", "minLength": 1}, "to": {"type": "string", "minLength": 1}}),
                &["path", "from", "to"],
            ),
            requires_permission: false,
        },
        ToolSpec {
            name: "history_checkpoint",
            title: "Save Checkpoint",
            description: "Commit an explicit, named document-history checkpoint now.".into(),
            input_schema: object_schema(json!({"message": {"type": "string", "minLength": 1}}), &["message"]),
            requires_permission: false,
        },
        ToolSpec {
            name: "history_restore",
            title: "Restore Version",
            description: "Restore a document's content to an earlier checkpoint. Writes through the normal editor pipeline, so an open editor picks it up like any other write.".into(),
            input_schema: object_schema(json!({"path": path, "checkpoint": {"type": "string", "minLength": 1}}), &["path", "checkpoint"]),
            requires_permission: true,
        },
        ToolSpec {
            name: WIDGET_RESPOND_TOOL_NAME,
            title: "Respond in Widget",
            description: format!(
                "Deliver your response to the in-document widget the prompt came from, once, as the turn's last step. Pick its `kind`: {}. An optional short `title` becomes the widget's heading. The widget renders inline, so keep `markdown` to a few sentences or a short list, and never restate what you wrote into the document. Never put a diff block in it: write the diff into the document, and say here where it is.",
                describe_response_kinds()
            ),
            input_schema: object_schema(
                json!({
                    "kind": {"type": "string", "enum": WIDGET_RESPONSE_KINDS.iter().map(|k| k.0).collect::<Vec<_>>()},
                    "markdown": {"type": "string", "minLength": 1, "pattern": DIFF_FENCE_ABSENT},
                    "title": {"type": "string", "maxLength": WIDGET_LIMIT_TITLE},
                    "options": {
                        "type": "array",
                        "items": {"type": "string", "minLength": 1, "maxLength": WIDGET_LIMIT_OPTION},
                        "minItems": 2,
                        "maxItems": 8,
                    },
                }),
                &["kind", "markdown"],
            ),
            requires_permission: false,
        },
    ]
}

/// `initialize.instructions` (`serverInstructions()`), verbatim.
pub fn server_instructions() -> String {
    let names = tool_registry()
        .iter()
        .map(|t| t.name)
        .collect::<Vec<_>>()
        .join(", ");
    let kinds = WIDGET_RESPONSE_KINDS
        .iter()
        .map(|k| k.0)
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "This server exposes the Notefig writing app's native tools ({names}); \
you are running as an agent inside that app. Notefig registers it for \
this session only, so it isn't in any config file and needs no checking. \
Three things are PRIMARY; the rest are for when a task calls for them. \
(1) The widget-context resource: a prompt sent from an in-document widget \
carries a `resource_link` whose URI starts with \
`notefig://widget-context`. Call `resources/read` on it as your \
FIRST action, before any document or file read. Its payload (title, \
heading outline, text around the prompt, the selection, the other open \
files) is sized to be enough for most requests: treat it as your default \
context. A widget prompt that OPENS with a blockquote (`> …` lines) \
quotes the passage the user had selected: that passage is what the \
prompt is about. Pass the payload's `selectedRange` `from`/`to` \
(padded outward if you like) to `document_read_range` to read it, or \
more around it, as it is now. \
(2) `widget_respond`: when a prompt carries that resource_link, you \
MUST deliver your final response by calling `widget_respond` with the \
kind that fits ({kinds}), even \
when the turn needed no tool actions: plain assistant text is progress \
notes, never the deliverable. When a prompt has no such link (it came \
from the chat panel), do NOT call `widget_respond`; answer in chat. \
A prompt from either surface may also carry `file://` resource_links, \
files the user referenced with @: don't `resources/read` those, read \
each one with `workspace_read_document` before acting. \
(3) `workspace_read_document`, for when the widget context doesn't \
cover the request (another section named in the outline, say). Do NOT \
read the entire document by default; read part of it with \
`line`/`limit`. \
Prefer these tools over generic file or shell tools for this \
workspace's documents: they see live editor state (unsaved edits, open \
tabs) and document history. A request about \"this section\" or \"this \
doc\" expects you to edit the document, not to describe the edit, unless \
the user is asking a question, or the request could mean different \
things and the document doesn't settle which: then ask with a choice \
before editing. {DIFF_BLOCK_GUIDE}"
    )
}

// ─── Validation ─────────────────────────────────────────────────────────────

/// A validated tool input; paths still workspace-relative strings.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolInput {
    ListDocuments,
    ReadDocument {
        path: String,
        line: Option<u64>,
        limit: Option<u64>,
    },
    DocumentReadRange {
        path: String,
        from: u64,
        to: u64,
    },
    OpenFiles,
    HistoryLog {
        path: Option<String>,
    },
    HistoryDiff {
        path: String,
        from: String,
        to: String,
    },
    HistoryCheckpoint {
        message: String,
    },
    HistoryRestore {
        path: String,
        checkpoint: String,
    },
    WidgetRespond(WidgetResponse),
}

/// The `widget_respond` payload.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WidgetResponse {
    pub kind: String,
    pub markdown: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

impl WidgetResponse {
    pub fn awaits_reply(&self) -> bool {
        WIDGET_RESPONSE_KINDS
            .iter()
            .any(|(k, _, awaits)| *k == self.kind && *awaits)
    }
}

/// Whether markdown carries a diff fence (```ts diff).
pub fn has_diff_fence(markdown: &str) -> bool {
    markdown.split('\n').any(|line| {
        let indent = line.chars().take_while(|c| *c == ' ').count();
        if indent > 3 {
            return false;
        }
        let rest = &line[indent..];
        let fence_char = match rest.chars().next() {
            Some(c @ ('`' | '~')) => c,
            _ => return false,
        };
        let fence_len = rest.chars().take_while(|c| *c == fence_char).count();
        if fence_len < 3 {
            return false;
        }
        let info: Vec<&str> = rest[fence_len..]
            .split([' ', '\t'])
            .filter(|w| !w.is_empty())
            .collect();
        info.iter()
            .enumerate()
            .skip(1)
            .any(|(i, w)| *w == "diff" && info[..i].iter().all(|p| !p.contains('`')))
    })
}

struct Problems(Vec<String>);

impl Problems {
    fn add(&mut self, field: &str, message: impl Into<String>) {
        self.0.push(format!("{field}: {}", message.into()));
    }
}

fn get_string(
    args: &Map<String, Value>,
    key: &str,
    required: bool,
    p: &mut Problems,
) -> Option<String> {
    match args.get(key) {
        None | Some(Value::Null) if !required => None,
        None | Some(Value::Null) => {
            p.add(key, "Required");
            None
        }
        Some(Value::String(s)) if s.is_empty() => {
            p.add(key, "String must contain at least 1 character(s)");
            None
        }
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => {
            p.add(key, "Expected string");
            None
        }
    }
}

fn get_int(
    args: &Map<String, Value>,
    key: &str,
    required: bool,
    min: i64,
    p: &mut Problems,
) -> Option<u64> {
    match args.get(key) {
        None | Some(Value::Null) if !required => None,
        None | Some(Value::Null) => {
            p.add(key, "Required");
            None
        }
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f >= min as f64 => Some(f as u64),
            Some(f) if f.fract() != 0.0 => {
                p.add(key, "Expected integer, received float");
                None
            }
            _ => {
                p.add(
                    key,
                    format!("Number must be greater than or equal to {min}"),
                );
                None
            }
        },
        Some(_) => {
            p.add(key, "Expected number");
            None
        }
    }
}

fn validate_widget(args: &Map<String, Value>, p: &mut Problems) -> Option<WidgetResponse> {
    let kind = get_string(args, "kind", true, p);
    if let Some(k) = &kind
        && !WIDGET_RESPONSE_KINDS.iter().any(|(name, _, _)| name == k)
    {
        p.add(
            "kind",
            format!(
                "Invalid enum value. Expected {}",
                WIDGET_RESPONSE_KINDS
                    .iter()
                    .map(|k| format!("'{}'", k.0))
                    .collect::<Vec<_>>()
                    .join(" | ")
            ),
        );
    }
    let markdown = get_string(args, "markdown", true, p);
    if markdown.as_deref().is_some_and(has_diff_fence) {
        p.add("markdown", "a diff block doesn't fit in a widget: write it into the document where the change belongs, then call again saying where it is");
    }
    let title = get_string(args, "title", false, p);
    if title
        .as_ref()
        .is_some_and(|t| t.chars().count() > WIDGET_LIMIT_TITLE)
    {
        p.add(
            "title",
            format!(
                "a title is at most {WIDGET_LIMIT_TITLE} characters — shorten it and call again"
            ),
        );
    }
    let options = match args.get("options") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            let mut out = vec![];
            for (i, item) in items.iter().enumerate() {
                match item.as_str() {
                    Some("") => p.add(&format!("options.{i}"), "String must contain at least 1 character(s)"),
                    Some(s) if s.chars().count() > WIDGET_LIMIT_OPTION => p.add(
                        &format!("options.{i}"),
                        format!("an option is at most {WIDGET_LIMIT_OPTION} characters — shorten it and call again"),
                    ),
                    Some(s) => out.push(s.to_string()),
                    None => p.add(&format!("options.{i}"), "Expected string"),
                }
            }
            if items.len() < 2 {
                p.add("options", "Array must contain at least 2 element(s)");
            }
            if items.len() > 8 {
                p.add("options", "Array must contain at most 8 element(s)");
            }
            Some(out)
        }
        Some(_) => {
            p.add("options", "Expected array");
            None
        }
    };
    let kind = kind?;
    let markdown = markdown?;
    let choice = kind == "single_choice" || kind == "multiple_choice";
    if choice && markdown.chars().count() > WIDGET_LIMIT_QUESTION {
        p.add("markdown", format!("a question is at most {WIDGET_LIMIT_QUESTION} characters — shorten it and call again"));
    }
    if choice && options.is_none() {
        p.add("options", format!("{kind} needs options"));
    }
    if !choice && options.is_some() {
        p.add(
            "options",
            "options are only for single_choice and multiple_choice",
        );
    }
    Some(WidgetResponse {
        kind,
        markdown,
        title,
        options,
    })
}

/// Validate a tool's arguments. Err = the problems, by field.
pub fn validate(tool: &str, args: &Value) -> Result<ToolInput, String> {
    let empty = Map::new();
    let args = match args {
        Value::Object(m) => m,
        Value::Null => &empty,
        _ => return Err("(input): Expected object".into()),
    };
    let mut p = Problems(vec![]);
    let input = match tool {
        "workspace_list_documents" => Some(ToolInput::ListDocuments),
        "workspace_open_files" => Some(ToolInput::OpenFiles),
        "workspace_read_document" => {
            let path = get_string(args, "path", true, &mut p);
            let line = get_int(args, "line", false, 1, &mut p);
            let limit = get_int(args, "limit", false, 1, &mut p);
            path.map(|path| ToolInput::ReadDocument { path, line, limit })
        }
        "document_read_range" => {
            let path = get_string(args, "path", true, &mut p);
            let from = get_int(args, "from", true, 0, &mut p);
            let to = get_int(args, "to", true, 0, &mut p);
            match (path, from, to) {
                (Some(path), Some(from), Some(to)) => {
                    Some(ToolInput::DocumentReadRange { path, from, to })
                }
                _ => None,
            }
        }
        "history_log" => Some(ToolInput::HistoryLog {
            path: get_string(args, "path", false, &mut p),
        }),
        "history_diff" => {
            let path = get_string(args, "path", true, &mut p);
            let from = get_string(args, "from", true, &mut p);
            let to = get_string(args, "to", true, &mut p);
            match (path, from, to) {
                (Some(path), Some(from), Some(to)) => {
                    Some(ToolInput::HistoryDiff { path, from, to })
                }
                _ => None,
            }
        }
        "history_checkpoint" => get_string(args, "message", true, &mut p)
            .map(|message| ToolInput::HistoryCheckpoint { message }),
        "history_restore" => {
            let path = get_string(args, "path", true, &mut p);
            let checkpoint = get_string(args, "checkpoint", true, &mut p);
            match (path, checkpoint) {
                (Some(path), Some(checkpoint)) => {
                    Some(ToolInput::HistoryRestore { path, checkpoint })
                }
                _ => None,
            }
        }
        WIDGET_RESPOND_TOOL_NAME => validate_widget(args, &mut p).map(ToolInput::WidgetRespond),
        _ => return Err(format!("unknown tool: {tool}")),
    };
    match input {
        Some(input) if p.0.is_empty() => Ok(input),
        _ => Err(p.0.join("; ")),
    }
}

/// One repair pass: stringified object/array values parsed (OpenCode
/// delivers nested arguments as JSON strings). None when nothing qualified.
pub fn parse_stringified_object_values(args: &Value) -> Option<Value> {
    let map = args.as_object()?;
    let mut repaired = false;
    let mut out = Map::new();
    for (k, v) in map {
        if let Value::String(s) = v {
            let t = s.trim_start();
            if (t.starts_with('{') || t.starts_with('['))
                && let Ok(parsed) = serde_json::from_str::<Value>(s)
            {
                out.insert(k.clone(), parsed);
                repaired = true;
                continue;
            }
        }
        out.insert(k.clone(), v.clone());
    }
    repaired.then_some(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_name_every_tool() {
        let text = server_instructions();
        assert!(text.starts_with("This server exposes the Notefig writing app's native tools (workspace_list_documents, workspace_read_document, document_read_range, workspace_open_files, history_log, history_diff, history_checkpoint, history_restore, widget_respond)"));
        assert!(text.contains("(answer, issue, single_choice, multiple_choice)"));
        assert!(text.ends_with("Its response then says where the diff is."));
    }

    #[test]
    fn widget_validation_matches_refinements() {
        assert!(
            validate(
                "widget_respond",
                &json!({"kind": "answer", "markdown": "done"})
            )
            .is_ok()
        );
        let err = validate(
            "widget_respond",
            &json!({"kind": "single_choice", "markdown": "which?"}),
        )
        .unwrap_err();
        assert!(err.contains("options: single_choice needs options"));
        let err = validate(
            "widget_respond",
            &json!({"kind": "answer", "markdown": "x", "options": ["a", "b"]}),
        )
        .unwrap_err();
        assert!(err.contains("options are only for"));
        let err = validate(
            "widget_respond",
            &json!({"kind": "answer", "markdown": "```ts diff\n-a\n+b\n```"}),
        )
        .unwrap_err();
        assert!(err.contains("diff block"));
        assert!(!has_diff_fence("```diff\n-a\n```"));
    }

    #[test]
    fn read_document_validation() {
        assert_eq!(
            validate(
                "workspace_read_document",
                &json!({"path": "a.md", "line": 2})
            )
            .unwrap(),
            ToolInput::ReadDocument {
                path: "a.md".into(),
                line: Some(2),
                limit: None
            }
        );
        let err = validate("workspace_read_document", &json!({"line": 0})).unwrap_err();
        assert!(err.contains("path: Required"));
        assert!(err.contains("line: Number must be greater than or equal to 1"));
    }

    #[test]
    fn repairs_stringified_values() {
        let fixed =
            parse_stringified_object_values(&json!({"options": "[\"a\",\"b\"]", "kind": "x"}))
                .unwrap();
        assert_eq!(fixed["options"], json!(["a", "b"]));
        assert!(parse_stringified_object_values(&json!({"a": "plain"})).is_none());
    }
}
