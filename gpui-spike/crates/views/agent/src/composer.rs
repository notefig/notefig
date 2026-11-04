//! The chat's floating composer (`PromptBox` in `agent-chat-tab.tsx`), with
//! what it is built from:
//!
//! - `composer-draft-store.ts` → [`ComposerDrafts`]: per-session drafts and
//!   last-sent prompts that outlive the tab's view.
//! - `deriveComposerButton` / `deriveComposerKeyAction`
//!   (`@notefig/widgets` prompt state) → [`derive_composer_button`],
//!   [`derive_composer_key_action`].
//! - The "@" suggestion (`mention-suggestion.ts`): directives first, then
//!   workspace files ([`search_directives`], [`MentionRow`]).
//! - The mention text contract (`draft-text.ts`: [`segment_mentions`],
//!   [`extract_mention_paths`]) and `promptToSend`
//!   (`prompt-widget-host.tsx`: [`mention_context_parts`], [`prompt_to_send`]).
//! - The `model:` and `skill:` directive namespaces
//!   (`modules/directives` + `modules/agents/agent-directives.ts`):
//!   [`agent_directive_sources`], [`resolve_directives`].
//!
//! Deviation: `crates/modules/directives` is not ported yet, so the
//! registry's resolve and the agents' two namespaces live here as pure
//! functions; move them onto that crate once it lands.

use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight,
    Global, InteractiveElement, IntoElement, KeyDownEvent, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Subscription, Window, div, prelude::FluentBuilder as _, px,
};
use markdown_editor::{BlockEditorEvent, BlockEditorState, SubmitPolicy};
use notefig_agent::model::{AgentTaskRow, AvailableCommand, SessionConfigSelect};
use notefig_agent::prompt::{ContextPartKind, PromptCommand, PromptConfigChange, PromptContextPart, PromptExtras};
use notefig_agents::{AgentStoreModule, AgentsModule};
use notefig_i18n::{t as tr, t_args};
use notefig_ui::{CoreExt as _, icon, observe, rem, sp, tokens};

use crate::config_bar::{ConfigBar, ConfigBarEvent};
use crate::glyph::harness_logo;
use crate::session_usage::session_usage_chip;
use crate::style::{PopoverSide, anchored_popover, popover_frame, radius_2xl, radius_xl, text_10};

pub fn init(_: &mut App) {}

// ─── composer-draft-store.ts ────────────────────────────────────────────────

/// Per-session composer drafts and last-sent prompts, outside any view: a
/// chat tab's view is rebuilt whenever its tab is shown again. Ephemeral by
/// design; task ids never recur, so nothing sweeps it.
#[derive(Default)]
pub struct ComposerDrafts {
    drafts: HashMap<String, String>,
    last_sent: HashMap<String, String>,
}

impl Global for ComposerDrafts {}

impl ComposerDrafts {
    pub fn get(&self, task_id: &str) -> String {
        self.drafts.get(task_id).cloned().unwrap_or_default()
    }

    /// An empty draft deletes the entry.
    pub fn set(&mut self, task_id: &str, draft: &str) {
        if draft.is_empty() {
            self.drafts.remove(task_id);
        } else {
            self.drafts.insert(task_id.to_string(), draft.to_string());
        }
    }

    pub fn clear(&mut self, task_id: &str) {
        self.drafts.remove(task_id);
    }

    /// The last prompt actually sent (Escape-to-cancel restores it).
    pub fn last_sent(&self, task_id: &str) -> String {
        self.last_sent.get(task_id).cloned().unwrap_or_default()
    }

    pub fn set_last_sent(&mut self, task_id: &str, text: &str) {
        if text.is_empty() {
            self.last_sent.remove(task_id);
        } else {
            self.last_sent.insert(task_id.to_string(), text.to_string());
        }
    }

    /// The app's store.
    pub fn global(cx: &mut App) -> &mut ComposerDrafts {
        cx.default_global::<ComposerDrafts>()
    }

    pub fn read(cx: &App) -> Option<&ComposerDrafts> {
        cx.try_global::<ComposerDrafts>()
    }
}

// ─── prompt state ────────────────────────────────────────────────────────────

/// `ComposerButtonMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComposerButtonMode {
    Send,
    Queue,
    Stop,
}

/// `deriveComposerButton`: Stop while a turn runs and nothing is typed;
/// Send otherwise (Queue while running). Stop is always actionable; Send
/// needs a draft and open inputs.
pub fn derive_composer_button(is_running: bool, draft_empty: bool, inputs_disabled: bool) -> (ComposerButtonMode, bool) {
    if is_running && draft_empty {
        return (ComposerButtonMode::Stop, true);
    }
    (
        if is_running { ComposerButtonMode::Queue } else { ComposerButtonMode::Send },
        !draft_empty && !inputs_disabled,
    )
}

/// `ComposerKeyAction`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ComposerKeyAction {
    Send,
    Cancel,
    Revert,
    Escape,
    BackspaceDismiss,
    None,
}

/// `deriveComposerKeyAction`.
pub fn derive_composer_key_action(
    key: &str,
    shift: bool,
    draft_empty: bool,
    can_revert: bool,
    can_dismiss: Option<bool>,
    in_flight: bool,
) -> ComposerKeyAction {
    let can_dismiss = can_dismiss.unwrap_or(can_revert);
    match key {
        "enter" if !shift => ComposerKeyAction::Send,
        "escape" if in_flight => ComposerKeyAction::Cancel,
        "escape" if draft_empty && can_revert => ComposerKeyAction::Revert,
        "escape" => ComposerKeyAction::Escape,
        "/" if draft_empty && can_revert => ComposerKeyAction::Revert,
        "backspace" if draft_empty && can_dismiss => ComposerKeyAction::BackspaceDismiss,
        _ => ComposerKeyAction::None,
    }
}

// ─── directives ──────────────────────────────────────────────────────────────

/// One thing a directive namespace offers.
#[derive(Clone, Debug, PartialEq)]
pub struct DirectiveCandidate {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
}

/// What a namespace does with the values a prompt gave it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectiveKind {
    /// A session setting of this category, switched before the turn (the
    /// last value wins).
    Setting(&'static str),
    /// Commands run with the prompt, in order.
    Skill,
}

/// A namespace as the "@" suggestion and the resolver see it.
#[derive(Clone, Debug, PartialEq)]
pub struct DirectiveSource {
    pub name: String,
    pub kind: DirectiveKind,
    pub candidates: Vec<DirectiveCandidate>,
}

/// A directive row of the "@" menu: a namespace to type into (`value:
/// None`), or one of its candidates.
#[derive(Clone, Debug, PartialEq)]
pub struct DirectiveRow {
    pub namespace: String,
    pub value: Option<String>,
    pub label: String,
    pub description: Option<String>,
}

/// A file row of the "@" menu.
#[derive(Clone, Debug, PartialEq)]
pub struct MentionFile {
    pub path: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum MentionRow {
    File(MentionFile),
    Directive(DirectiveRow),
}

/// How many files the menu lists for a query.
pub const SUGGESTION_LIMIT: usize = 8;
/// Directive rows for a query that names no namespace.
const UNSCOPED_DIRECTIVE_LIMIT: usize = 5;

/// `isDirectiveToken`: `<namespace>:<value>`, which a path never starts like.
pub fn is_directive_token(token: &str) -> bool {
    let Some((ns, value)) = token.split_once(':') else { return false };
    let mut chars = ns.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c == '-')
        && value.chars().next().is_some_and(|c| !c.is_whitespace())
}

/// `findDirective`: the source and value a token names, if offered now.
pub fn find_directive<'a>(sources: &'a [DirectiveSource], token: &str) -> Option<(&'a DirectiveSource, String)> {
    let colon = token.find(':').filter(|c| *c > 0)?;
    let source = sources.iter().find(|s| s.name == token[..colon])?;
    let value = &token[colon + 1..];
    source.candidates.iter().any(|c| c.value == value).then(|| (source, value.to_string()))
}

/// Prefix matches first, then substring ones, on value or label.
fn rank(candidates: &[DirectiveCandidate], query: &str) -> Vec<DirectiveCandidate> {
    let needle = query.to_lowercase();
    let at = |c: &DirectiveCandidate| {
        [&c.value, &c.label]
            .iter()
            .map(|text| match text.to_lowercase().find(&needle) {
                None => usize::MAX,
                Some(0) => 0,
                Some(_) => 1,
            })
            .min()
            .unwrap_or(usize::MAX)
    };
    let mut ranked: Vec<(usize, &DirectiveCandidate)> =
        candidates.iter().map(|c| (at(c), c)).filter(|(a, _)| *a != usize::MAX).collect();
    ranked.sort_by_key(|(a, _)| *a);
    ranked.into_iter().map(|(_, c)| c.clone()).collect()
}

/// `searchDirectives`: `<ns>:<query>` lists that namespace's matches; a
/// query starting a namespace's name lists its members; any other lists
/// members it matches; a bare "@" lists the namespaces.
pub fn search_directives(sources: &[DirectiveSource], query: &str) -> Vec<DirectiveRow> {
    let row = |name: &str, c: DirectiveCandidate| DirectiveRow {
        namespace: name.to_string(),
        value: Some(c.value),
        label: c.label,
        description: c.description,
    };
    if let Some(colon) = query.find(':').filter(|c| *c > 0)
        && let Some(scoped) = sources.iter().find(|s| s.name == query[..colon])
    {
        return rank(&scoped.candidates, &query[colon + 1..])
            .into_iter()
            .take(SUGGESTION_LIMIT)
            .map(|c| row(&scoped.name, c))
            .collect();
    }
    if query.is_empty() {
        return sources
            .iter()
            .map(|s| DirectiveRow { namespace: s.name.clone(), value: None, label: format!("{}:", s.name), description: None })
            .collect();
    }
    let named = query.to_lowercase();
    sources
        .iter()
        .flat_map(|s| {
            let list = if s.name.starts_with(&named) { s.candidates.clone() } else { rank(&s.candidates, query) };
            list.into_iter().map(|c| row(&s.name, c)).collect::<Vec<_>>()
        })
        .take(UNSCOPED_DIRECTIVE_LIMIT)
        .collect()
}

/// What a prompt's session offers: its own reports, else its harness's
/// catalog (`offerOf`).
pub fn agent_directive_sources(
    row: Option<&AgentTaskRow>,
    catalog_options: &[SessionConfigSelect],
    catalog_commands: &[AvailableCommand],
) -> Vec<DirectiveSource> {
    let options: Vec<SessionConfigSelect> = match row.and_then(|r| r.config_options.clone()) {
        Some(own) if !own.is_empty() => own,
        _ => catalog_options.to_vec(),
    };
    let commands: Vec<AvailableCommand> = match row.and_then(|r| r.commands.clone()) {
        Some(own) if !own.is_empty() => own,
        _ => catalog_commands.to_vec(),
    };
    let model = options
        .iter()
        .find(|o| o.category.as_deref() == Some("model"))
        .map(|o| {
            o.choices()
                .into_iter()
                // Names only: descriptions crowd the menu.
                .map(|c| DirectiveCandidate { value: c.value.clone(), label: c.name.clone(), description: None })
                .collect()
        })
        .unwrap_or_default();
    let skill = commands
        .iter()
        .map(|c| DirectiveCandidate {
            value: c.name.clone(),
            label: c.name.clone(),
            description: (!c.description.is_empty()).then(|| c.description.clone()),
        })
        .collect();
    vec![
        DirectiveSource { name: "model".into(), kind: DirectiveKind::Setting("model"), candidates: model },
        DirectiveSource { name: "skill".into(), kind: DirectiveKind::Skill, candidates: skill },
    ]
}

/// `directives.resolve`: the prompt without its directives, and what they
/// ask it to be sent with. Tokens that name nothing stay text; a prompt
/// that was nothing but settings keeps its text.
pub fn resolve_directives(text: &str, sources: &[DirectiveSource]) -> (String, Vec<PromptConfigChange>, Vec<PromptCommand>) {
    let mut tokens: Vec<String> = Vec::new();
    let mut stripped = String::new();
    let mut drop_space = false;
    for segment in segment_mentions(text, |token| find_directive(sources, token).is_some()) {
        match segment {
            MentionSegment::Mention(value) => {
                tokens.push(value);
                drop_space = stripped.is_empty() || stripped.ends_with(char::is_whitespace);
            }
            MentionSegment::Text(value) => {
                if drop_space {
                    stripped.push_str(value.strip_prefix(' ').unwrap_or(&value));
                } else {
                    stripped.push_str(&value);
                }
                drop_space = false;
            }
        }
    }
    let stripped = stripped.trim().to_string();
    // Group by namespace in first-use order.
    let mut used: Vec<(&DirectiveSource, Vec<String>)> = Vec::new();
    for token in &tokens {
        let (source, value) = find_directive(sources, token).expect("segmented as a directive");
        match used.iter_mut().find(|(s, _)| s.name == source.name) {
            Some((_, values)) => values.push(value),
            None => used.push((source, vec![value])),
        }
    }
    let mut config = Vec::new();
    let mut commands = Vec::new();
    for (source, values) in used {
        match source.kind {
            DirectiveKind::Setting(category) => config.push(PromptConfigChange {
                category: category.into(),
                value: values.last().cloned().unwrap_or_default(),
            }),
            DirectiveKind::Skill => commands.extend(values.into_iter().map(|name| PromptCommand { name })),
        }
    }
    let text = if !stripped.is_empty() || !commands.is_empty() { stripped } else { text.to_string() };
    (text, config, commands)
}

// ─── draft-text.ts: the mention text contract ────────────────────────────────

const MAX_MENTION_WORDS: usize = 16;
const TRAILING_PUNCTUATION: &[char] = &['.', ',', ';', ':', '!', '?', ')', ']', '}', '\'', '"', '`'];

/// A run of plain text or a resolved mention.
#[derive(Clone, Debug, PartialEq)]
pub enum MentionSegment {
    Text(String),
    Mention(String),
}

/// The line's word-boundary prefixes after an "@", shortest first.
fn mention_candidates(rest: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut in_word = false;
    for (i, c) in rest.char_indices() {
        if c.is_whitespace() {
            if in_word {
                out.push(&rest[..i]);
                if out.len() >= MAX_MENTION_WORDS {
                    return out;
                }
            }
            in_word = false;
        } else {
            in_word = true;
        }
    }
    if in_word && out.len() < MAX_MENTION_WORDS {
        out.push(rest);
    }
    out
}

/// Multi-word candidates must look like a filename or end the line.
fn is_plausible_mention(candidate: &str, rest: &str) -> bool {
    if !candidate.contains(char::is_whitespace) || candidate.len() == rest.len() {
        return true;
    }
    candidate.rsplit(char::is_whitespace).next().is_some_and(|w| w.contains('.'))
}

fn resolve_candidate(candidate: &str, is_path: &dyn Fn(&str) -> bool) -> Option<String> {
    if is_path(candidate) {
        return Some(candidate.to_string());
    }
    let stripped = candidate.trim_end_matches(TRAILING_PUNCTUATION);
    (!stripped.is_empty() && stripped != candidate && is_path(stripped)).then(|| stripped.to_string())
}

/// `segmentMentions`: split a prompt into text runs and resolved mentions.
/// For each "@" at the start or after whitespace, the line's word-boundary
/// prefixes are tried longest first (with trailing punctuation stripped).
pub fn segment_mentions(text: &str, is_path: impl Fn(&str) -> bool) -> Vec<MentionSegment> {
    let mut segments = Vec::new();
    let mut plain_from = 0usize;
    let mut search = 0usize;
    while let Some(off) = text[search..].find('@') {
        let at = search + off;
        search = at + 1;
        let starts = at == 0 || text[..at].ends_with(char::is_whitespace);
        if !starts {
            continue;
        }
        let start = at + 1;
        let line_end = text[start..].find('\n').map(|n| start + n).unwrap_or(text.len());
        let rest = &text[start..line_end];
        if rest.is_empty() || rest.starts_with(char::is_whitespace) {
            continue;
        }
        let candidates = mention_candidates(rest);
        let hit = candidates.iter().rev().find_map(|c| {
            if !is_plausible_mention(c, rest) {
                return None;
            }
            resolve_candidate(c, &is_path).map(|hit| (hit, c.len()))
        });
        let Some((hit, consumed)) = hit else { continue };
        if at > plain_from {
            segments.push(MentionSegment::Text(text[plain_from..at].to_string()));
        }
        plain_from = start + hit.len();
        segments.push(MentionSegment::Mention(hit));
        search = start + consumed;
    }
    if text.len() > plain_from {
        segments.push(MentionSegment::Text(text[plain_from..].to_string()));
    }
    segments
}

/// `extractMentionPaths`: every distinct resolved mention, in order.
pub fn extract_mention_paths(text: &str, is_path: impl Fn(&str) -> bool) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for segment in segment_mentions(text, is_path) {
        if let MentionSegment::Mention(v) = segment
            && !found.contains(&v)
        {
            found.push(v);
        }
    }
    found
}

/// `pathutil.toFileUri`: `file://` + the path, each segment percent-encoded.
pub fn to_file_uri(path: &str) -> String {
    let encoded: Vec<String> = path
        .split('/')
        .map(|seg| {
            seg.bytes()
                .map(|b| match b {
                    b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'!' | b'\'' | b'(' | b')' | b'*' => {
                        (b as char).to_string()
                    }
                    _ => format!("%{b:02X}"),
                })
                .collect()
        })
        .collect();
    format!("file://{}", encoded.join("/"))
}

/// `mentionContextParts`: tokens naming real workspace files (never
/// directories) as `file://` resource links.
pub fn mention_context_parts(workspace_path: &str, text: &str, is_file: impl Fn(&str) -> bool) -> Vec<PromptContextPart> {
    extract_mention_paths(text, is_file)
        .into_iter()
        .map(|token| PromptContextPart {
            kind: ContextPartKind::ResourceLink,
            path: to_file_uri(&format!("{}/{}", workspace_path.trim_end_matches('/'), token)),
            content: None,
            name: Some(token),
        })
        .collect()
}

/// The workspace's files (relative path → absolute), from the files
/// module when the workspace is open.
fn workspace_files(cx: &App, workspace_path: &str) -> Option<Rc<notefig_files::WorkspaceFiles>> {
    let core = cx.core();
    core.try_use::<notefig_files::FilesModule>()?;
    core.workspace(workspace_path).get::<notefig_files::FilesModule>().ok()
}

fn is_workspace_file(files: &notefig_files::WorkspaceFiles, token: &str) -> bool {
    files.metadata().get(&files.absolute(token)).is_some_and(|m| !m.is_dir())
}

/// The directive sources for a session (its row, else its harness's catalog).
pub fn sources_for(cx: &App, task_id: &str, harness_id: &str) -> Vec<DirectiveSource> {
    let store = cx.core().use_::<AgentStoreModule>();
    let row = store.task(task_id);
    let catalog = store.harness_rows().into_iter().find(|h| h.id == harness_id).and_then(|h| h.catalog);
    let (options, commands) = catalog
        .map(|c| (c.config_options.unwrap_or_default(), c.commands.unwrap_or_default()))
        .unwrap_or_default();
    agent_directive_sources(row.as_ref(), &options, &commands)
}

/// `promptToSend`: the directives resolved out of the text, and its file
/// mentions as context parts.
pub fn prompt_to_send(cx: &App, workspace_path: &str, task_id: &str, harness_id: &str, text: &str) -> (String, PromptExtras) {
    let sources = sources_for(cx, task_id, harness_id);
    let (text, config, commands) = resolve_directives(text, &sources);
    let context_parts = match workspace_files(cx, workspace_path) {
        Some(files) => mention_context_parts(workspace_path, &text, |token| is_workspace_file(&files, token)),
        None => Vec::new(),
    };
    (text, PromptExtras { context_parts, commands, config })
}

// ─── the composer ────────────────────────────────────────────────────────────

pub enum ComposerEvent {
    /// ⏎ or the Send/Queue button with a draft.
    Send,
    /// The Stop button.
    Stop,
    /// Escape while a turn runs: cancel it and restore the sent prompt.
    CancelRestore,
}

struct MentionMenu {
    rows: Vec<MentionRow>,
    selected: usize,
    /// Bytes of `@query` before the caret.
    token_len: usize,
}

/// `PromptBox`: the prompt editor above its footer (harness, session
/// settings, context meter, the morphing action button).
pub struct Composer {
    task_id: String,
    workspace_path: String,
    harness_id: String,
    pub editor: Entity<BlockEditorState>,
    config: Entity<ConfigBar>,
    menu: Option<MentionMenu>,
    usage_open: bool,
    is_running: bool,
    disabled: bool,
    dictation_key: Option<String>,
    /// Programmatic writes don't echo back into the draft store.
    applying: bool,
    _subs: Vec<Subscription>,
    _store: notefig_core::Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Composer {
    pub fn new(task_id: String, workspace_path: String, harness_id: String, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let draft = ComposerDrafts::read(cx).map(|d| d.get(&task_id)).unwrap_or_default();
        let editor = cx.new(|cx| {
            let mut state = BlockEditorState::new(window, cx).with_submit_policy(SubmitPolicy::Enter);
            state.set_slash_trigger(false);
            if !draft.is_empty() {
                let _ = state.set_source(&draft, cx);
                let _ = state.select_end(cx);
            }
            state
        });
        let config = cx.new(|cx| ConfigBar::new(task_id.clone(), cx));
        let subs = vec![
            cx.subscribe_in(&editor, window, Self::on_editor_event),
            cx.subscribe_in(&config, window, |this, _, event, window, cx| match event {
                ConfigBarEvent::Closed => {
                    this.focus(window, cx);
                }
            }),
        ];
        let store = cx.core().use_::<AgentStoreModule>();
        let id = task_id.clone();
        let store_sub = observe(cx, move |notify| store.subscribe_task(&id, move || notify()));
        let dictation_key = cx.core().try_use::<notefig_dictation::DictationModule>().map(|d| {
            notefig_dictation::hold_key_label(d.hold_key(), notefig_dictation::KeyPlatform::current())
        });
        let mut this = Self {
            task_id,
            workspace_path,
            harness_id,
            editor,
            config,
            menu: None,
            usage_open: false,
            is_running: false,
            disabled: false,
            dictation_key,
            applying: false,
            _subs: subs,
            _store: store_sub,
        };
        this.apply_placeholder(cx);
        this
    }

    /// The tab tells the composer what the session is doing.
    pub fn set_state(&mut self, is_running: bool, disabled: bool, cx: &mut Context<Self>) {
        if self.is_running == is_running && self.disabled == disabled {
            return;
        }
        self.is_running = is_running;
        let was_disabled = self.disabled;
        self.disabled = disabled;
        if was_disabled != disabled {
            self.editor.update(cx, |e, cx| e.set_readonly(disabled, cx));
            self.apply_placeholder(cx);
        }
        cx.notify();
    }

    fn placeholder(&self) -> String {
        if self.disabled {
            tr("agentLoadingSession")
        } else if let Some(key) = &self.dictation_key {
            t_args("agentPromptPlaceholderDictation", &[("key", key)])
        } else {
            tr("agentPromptPlaceholder")
        }
    }

    fn apply_placeholder(&mut self, cx: &mut Context<Self>) {
        let text: SharedString = self.placeholder().into();
        self.editor.update(cx, |e, cx| e.set_placeholder(Some(text), cx));
    }

    /// The draft as sent: the editor's text (mentions as `@path`).
    pub fn text(&self, cx: &App) -> String {
        self.editor.read(cx).source().trim().to_string()
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.applying = true;
        self.editor.update(cx, |e, cx| {
            let _ = e.set_source(text, cx);
            let _ = e.select_end(cx);
        });
        self.applying = false;
        ComposerDrafts::global(cx).set(&self.task_id, text);
        self.menu = None;
        cx.notify();
    }

    /// The tab controller focuses the tab through this; false while the
    /// composer declines (the session is loading).
    pub fn focus(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.disabled {
            return false;
        }
        let editor = self.editor.clone();
        editor.update(cx, |e, cx| e.focus(window, cx));
        true
    }

    pub fn is_focused(&self, window: &Window, cx: &App) -> bool {
        self.editor.focus_handle(cx).contains_focused(window, cx)
    }

    fn on_editor_event(&mut self, _: &Entity<BlockEditorState>, event: &BlockEditorEvent, window: &mut Window, cx: &mut Context<Self>) {
        match event {
            BlockEditorEvent::SubmitRequested => {
                if self.menu.as_ref().is_some_and(|m| !m.rows.is_empty()) {
                    self.accept(window, cx);
                } else if derive_composer_key_action("enter", false, self.text(cx).is_empty(), false, None, self.is_running)
                    == ComposerKeyAction::Send
                {
                    cx.emit(ComposerEvent::Send);
                }
            }
            BlockEditorEvent::Changed { .. } => {
                if !self.applying {
                    let source = self.editor.read(cx).source();
                    let draft = source.trim_end_matches('\n').to_string();
                    ComposerDrafts::global(cx).set(&self.task_id, &draft);
                }
                self.refresh_menu(cx);
                cx.notify();
            }
            BlockEditorEvent::SelectionChanged => self.refresh_menu(cx),
            _ => {}
        }
    }

    /// The `@query` right before the caret, if the caret is in one.
    fn current_query(&self, cx: &App) -> Option<String> {
        let prefix = self.editor.read(cx).caret_prefix()?.to_string();
        let at = prefix.rfind('@')?;
        let before_ok = at == 0 || prefix[..at].ends_with(char::is_whitespace);
        let query = &prefix[at + 1..];
        (before_ok && !query.contains(char::is_whitespace)).then(|| query.to_string())
    }

    fn refresh_menu(&mut self, cx: &mut Context<Self>) {
        let Some(query) = self.current_query(cx) else {
            if self.menu.take().is_some() {
                cx.notify();
            }
            return;
        };
        let rows = self.search(&query, cx);
        let selected = self.menu.as_ref().map(|m| m.selected).unwrap_or(0).min(rows.len().saturating_sub(1));
        self.menu = Some(MentionMenu { rows, selected, token_len: query.len() + 1 });
        cx.notify();
    }

    /// `hostMentionSearch`: directives first, then files.
    fn search(&self, query: &str, cx: &App) -> Vec<MentionRow> {
        let sources = sources_for(cx, &self.task_id, &self.harness_id);
        let mut rows: Vec<MentionRow> = search_directives(&sources, query).into_iter().map(MentionRow::Directive).collect();
        if let Some(files) = workspace_files(cx, &self.workspace_path) {
            let meta = files.metadata().rows();
            let options = notefig_files::file_score::FileSearchOptions {
                limit: Some(SUGGESTION_LIMIT),
                filter: Some(Rc::new(notefig_editors::can_open_file)),
                match_all_when_empty: true,
            };
            let ranked = notefig_files::file_score::rank_file_rows(
                meta.iter().filter(|m| !m.is_dir()).map(|m| notefig_files::file_score::RankRow {
                    path: &m.path,
                    relative_path: m.relative_path.as_deref(),
                    search_key: None,
                }),
                query,
                &options,
            );
            rows.extend(ranked.into_iter().map(|r| MentionRow::File(MentionFile { path: r.path, relative_path: r.relative_path })));
        }
        rows
    }

    /// Insert the picked row: a chip for a file or a directive value; a
    /// namespace row types `@ns:` so its members list next.
    fn accept(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(menu) = self.menu.take() else { return };
        let Some(row) = menu.rows.get(menu.selected).cloned() else { return };
        let len = menu.token_len;
        self.editor.update(cx, |e, cx| {
            let Ok(mut range) = e.capture_suffix(len) else { return };
            match &row {
                MentionRow::Directive(DirectiveRow { namespace, value: None, .. }) => {
                    let _ = e.replace_captured(&mut range, &format!("@{namespace}:"), cx);
                }
                MentionRow::Directive(DirectiveRow { namespace, value: Some(v), .. }) => {
                    let _ = e.replace_captured(&mut range, "", cx);
                    let _ = e.insert_mention(&format!("{namespace}:{v}"), cx);
                }
                MentionRow::File(file) => {
                    let _ = e.replace_captured(&mut range, "", cx);
                    let _ = e.insert_mention(&file.relative_path, cx);
                }
            }
        });
        self.focus(window, cx);
        self.refresh_menu(cx);
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        if let Some(menu) = self.menu.as_mut().filter(|m| !m.rows.is_empty()) {
            let n = menu.rows.len();
            match key {
                "up" => menu.selected = (menu.selected + n - 1) % n,
                "down" => menu.selected = (menu.selected + 1) % n,
                "tab" | "enter" => self.accept(window, cx),
                "escape" => self.menu = None,
                _ => return,
            }
            cx.notify();
            cx.stop_propagation();
            return;
        }
        if key == "escape" {
            let action =
                derive_composer_key_action("escape", event.keystroke.modifiers.shift, self.text(cx).is_empty(), false, None, self.is_running);
            // Idle Escape stays a no-op: the chat has no document to go back to.
            if action == ComposerKeyAction::Cancel {
                cx.emit(ComposerEvent::CancelRestore);
                cx.stop_propagation();
            }
        }
    }

    fn render_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let menu = self.menu.as_ref().filter(|m| !m.rows.is_empty())?;
        let t = tokens(cx);
        let (muted, fg, brand) = (t.muted_foreground, t.foreground, t.brand);
        let rows = menu.rows.iter().enumerate().map(|(ix, row)| {
            let selected = ix == menu.selected;
            let (lead, body): (AnyElement, AnyElement) = match row {
                MentionRow::Directive(d) => (
                    icon(directive_icon(&d.namespace)).size(sp(4.)).text_color(muted).into_any_element(),
                    div()
                        .flex()
                        .min_w_0()
                        .gap(sp(1.5))
                        .child(div().truncate().child(d.label.clone()))
                        .when_some(d.description.clone(), |e, desc| e.child(div().truncate().text_color(muted).child(desc)))
                        .into_any_element(),
                ),
                MentionRow::File(f) => {
                    let slash = f.relative_path.rfind('/').map(|i| i + 1).unwrap_or(0);
                    let md = f.relative_path.ends_with(".md") || f.relative_path.ends_with(".markdown");
                    (
                        if md {
                            div()
                                .flex_none()
                                .w(sp(4.))
                                .text_size(text_10())
                                .font_weight(FontWeight::BOLD)
                                .text_color(brand)
                                .child("M↓")
                                .into_any_element()
                        } else {
                            icon("file").size(sp(4.)).text_color(muted).into_any_element()
                        },
                        div()
                            .flex()
                            .min_w_0()
                            .child(div().flex_none().text_color(muted).child(f.relative_path[..slash].to_string()))
                            .child(div().truncate().text_color(fg).child(f.relative_path[slash..].to_string()))
                            .into_any_element(),
                    )
                }
            };
            crate::style::menu_item(SharedString::from(format!("mention-row-{ix}")), selected, cx)
                .on_mouse_move(cx.listener(move |this, _, _, cx| {
                    if let Some(m) = this.menu.as_mut()
                        && m.selected != ix
                    {
                        m.selected = ix;
                        cx.notify();
                    }
                }))
                .on_mouse_down(gpui::MouseButton::Left, |_, window, _| window.prevent_default())
                .on_click(cx.listener(move |this, _, window, cx| {
                    if let Some(m) = this.menu.as_mut() {
                        m.selected = ix;
                    }
                    this.accept(window, cx);
                }))
                .child(lead)
                .child(body)
        });
        Some(anchored_popover(
            PopoverSide::BelowStart,
            popover_frame(cx).id("mention-menu").min_w(rem(16.)).max_w(rem(24.)).p(sp(1.)).flex().flex_col().children(rows),
        ))
    }

    fn render_action_button(&self, draft_empty: bool, cx: &mut Context<Self>) -> AnyElement {
        let t = tokens(cx);
        let (mode, enabled) = derive_composer_button(self.is_running, draft_empty, self.disabled);
        let label = match mode {
            ComposerButtonMode::Stop => tr("agentStop"),
            ComposerButtonMode::Queue => tr("agentQueue"),
            ComposerButtonMode::Send => tr("agentSend"),
        };
        let variant = if mode == ComposerButtonMode::Stop {
            crate::style::ButtonVariant::Outline
        } else {
            crate::style::ButtonVariant::Default
        };
        let glyph: AnyElement = if mode == ComposerButtonMode::Stop {
            div().size(sp(4.)).rounded(px(2.)).bg(t.foreground).into_any_element()
        } else {
            icon("arrow-up").size(sp(4.)).text_color(t.primary_foreground).into_any_element()
        };
        let label: SharedString = label.into();
        crate::style::button("composer-action", variant, crate::style::ButtonSize::Icon, !enabled, cx)
            .size(sp(9.))
            .rounded(radius_xl())
            .child(glyph)
            .tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(label.clone()).build(window, cx))
            .when(enabled, |b| {
                b.on_click(cx.listener(move |_, _, _, cx| {
                    cx.emit(if mode == ComposerButtonMode::Stop { ComposerEvent::Stop } else { ComposerEvent::Send })
                }))
            })
            .into_any_element()
    }
}

/// `DirectiveIcon`: each namespace's mark in the "@" menu.
fn directive_icon(namespace: &str) -> &'static str {
    match namespace {
        "model" => "sparkles",
        "skill" => "zap",
        _ => "at-sign",
    }
}

impl Focusable for Composer {
    fn focus_handle(&self, cx: &App) -> FocusHandle {
        self.editor.focus_handle(cx)
    }
}

impl Render for Composer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        let (muted, border, card) = (t.muted_foreground, t.border, t.card);
        let draft_empty = self.text(cx).is_empty();
        let agents = cx.core().use_::<AgentsModule>();
        let harness_label = agents.harness_label(&self.harness_id);
        let usage = cx.core().use_::<AgentStoreModule>().task(&self.task_id).and_then(|r| r.usage);
        let chip = session_usage_chip(
            "session-usage",
            usage.as_ref(),
            self.usage_open,
            {
                let this = cx.entity().downgrade();
                move |open, window, cx| {
                    let _ = this.update(cx, |this, cx| {
                        this.usage_open = open;
                        if !open {
                            this.focus(window, cx);
                        }
                        cx.notify();
                    });
                }
            },
            cx,
        );
        let editor = div()
            .relative()
            .w_full()
            .min_h(rem(2.75))
            .max_h(rem(14.))
            .px(sp(4.))
            .pt(sp(3.))
            .text_size(t.text_sm)
            .child(markdown_editor::BlockEditor::new(&self.editor).w_full())
            .children(self.render_menu(cx));
        div()
            .id("prompt-box")
            .w_full()
            .rounded(radius_2xl())
            .border_1()
            .border_color(border)
            .bg(card)
            .shadow_lg()
            .capture_key_down(cx.listener(Self::on_key))
            .child(editor)
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap(sp(1.))
                    .px(sp(2.))
                    .pb(sp(1.5))
                    .child(
                        div()
                            .flex()
                            .h(sp(4.))
                            .items_center()
                            .gap(sp(1.))
                            .px(sp(1.))
                            .text_size(text_10())
                            .line_height(sp(4.))
                            .text_color(muted)
                            .child(harness_logo(&self.harness_id, sp(2.5), muted))
                            .child(harness_label),
                    )
                    .child(self.config.clone())
                    .child(
                        div()
                            .ml_auto()
                            .flex()
                            .items_end()
                            .gap(sp(1.))
                            .children(chip)
                            .child(self.render_action_button(draft_empty, cx)),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // composer-draft-store.test.ts
    #[test]
    fn stores_and_returns_drafts_per_task() {
        let mut d = ComposerDrafts::default();
        d.set("task_a", "hello");
        d.set("task_b", "world");
        assert_eq!(d.get("task_a"), "hello");
        assert_eq!(d.get("task_b"), "world");
    }

    #[test]
    fn unknown_tasks_have_empty_drafts() {
        assert_eq!(ComposerDrafts::default().get("task_unknown"), "");
    }

    #[test]
    fn setting_an_empty_draft_deletes_the_entry() {
        let mut d = ComposerDrafts::default();
        d.set("task_c", "draft");
        d.set("task_c", "");
        assert_eq!(d.get("task_c"), "");
        assert!(d.drafts.is_empty());
    }

    #[test]
    fn clear_removes_the_draft() {
        let mut d = ComposerDrafts::default();
        d.set("task_d", "draft");
        d.clear("task_d");
        assert_eq!(d.get("task_d"), "");
    }

    #[test]
    fn last_sent_is_independent_of_the_draft() {
        let mut d = ComposerDrafts::default();
        d.set_last_sent("task_e", "sent text");
        d.set("task_e", "new draft");
        assert_eq!(d.last_sent("task_e"), "sent text");
        assert_eq!(d.get("task_e"), "new draft");
        assert_eq!(d.last_sent("task_unknown"), "");
    }

    // prompt state.test.ts (composer parts)
    #[test]
    fn button_is_stop_while_running_and_empty() {
        assert_eq!(derive_composer_button(true, true, false), (ComposerButtonMode::Stop, true));
        assert_eq!(derive_composer_button(true, false, false), (ComposerButtonMode::Queue, true));
        assert_eq!(derive_composer_button(false, false, false), (ComposerButtonMode::Send, true));
        assert_eq!(derive_composer_button(false, true, false), (ComposerButtonMode::Send, false));
        assert_eq!(derive_composer_button(false, false, true), (ComposerButtonMode::Send, false));
        assert_eq!(derive_composer_button(true, true, true), (ComposerButtonMode::Stop, true));
    }

    #[test]
    fn key_actions() {
        assert_eq!(derive_composer_key_action("enter", false, true, false, None, false), ComposerKeyAction::Send);
        assert_eq!(derive_composer_key_action("enter", true, false, false, None, false), ComposerKeyAction::None);
        assert_eq!(derive_composer_key_action("escape", false, false, false, None, true), ComposerKeyAction::Cancel);
        assert_eq!(derive_composer_key_action("escape", false, true, true, None, false), ComposerKeyAction::Revert);
        assert_eq!(derive_composer_key_action("escape", false, true, false, None, false), ComposerKeyAction::Escape);
        assert_eq!(derive_composer_key_action("/", false, true, true, None, false), ComposerKeyAction::Revert);
        assert_eq!(derive_composer_key_action("backspace", false, true, true, None, false), ComposerKeyAction::BackspaceDismiss);
        assert_eq!(derive_composer_key_action("backspace", false, true, false, Some(true), false), ComposerKeyAction::BackspaceDismiss);
    }

    // directives.test.ts
    fn sources() -> Vec<DirectiveSource> {
        let c = |v: &str, l: &str| DirectiveCandidate { value: v.into(), label: l.into(), description: None };
        vec![
            DirectiveSource {
                name: "model".into(),
                kind: DirectiveKind::Setting("model"),
                candidates: vec![c("opus", "Opus"), c("sonnet", "Sonnet"), c("anthropic/haiku", "Haiku")],
            },
            DirectiveSource { name: "skill".into(), kind: DirectiveKind::Skill, candidates: vec![c("review", "review")] },
        ]
    }

    #[test]
    fn takes_known_directives_out_of_the_text() {
        let (text, config, commands) =
            resolve_directives("@model:opus fix @notes.md then @skill:review it @model:sonnet", &sources());
        assert_eq!(text, "fix @notes.md then it");
        assert_eq!(config, vec![PromptConfigChange { category: "model".into(), value: "sonnet".into() }]);
        assert_eq!(commands, vec![PromptCommand { name: "review".into() }]);
    }

    #[test]
    fn leaves_tokens_that_name_nothing() {
        let (text, config, commands) = resolve_directives("use @model:nope and a@model:opus", &sources());
        assert_eq!(text, "use @model:nope and a@model:opus");
        assert!(config.is_empty() && commands.is_empty());
    }

    #[test]
    fn a_settings_only_prompt_keeps_its_text() {
        let (text, config, _) = resolve_directives("@model:opus", &sources());
        assert_eq!(text, "@model:opus");
        assert_eq!(config.len(), 1);
        assert_eq!(resolve_directives("@skill:review", &sources()).0, "");
    }

    // mention-suggestion.test.ts
    #[test]
    fn bare_at_lists_namespaces() {
        let rows = search_directives(&sources(), "");
        assert_eq!(rows.iter().map(|r| r.label.as_str()).collect::<Vec<_>>(), ["model:", "skill:"]);
        assert!(rows.iter().all(|r| r.value.is_none()));
    }

    #[test]
    fn scoped_and_unscoped_search() {
        let scoped = search_directives(&sources(), "model:s");
        // As TS `rank`: prefix matches first, then substring ones ("opu*s*").
        assert_eq!(scoped.iter().filter_map(|r| r.value.as_deref()).collect::<Vec<_>>(), ["sonnet", "opus"]);
        let named = search_directives(&sources(), "mo");
        assert_eq!(named.len(), 3);
        let member = search_directives(&sources(), "hai");
        assert_eq!(member[0].value.as_deref(), Some("anthropic/haiku"));
        assert!(is_directive_token("model:opus"));
        assert!(!is_directive_token("notes.md"));
        assert!(!is_directive_token("Model:x"));
    }

    // agent-directives.test.ts
    #[test]
    fn offers_the_sessions_own_models_else_the_catalog() {
        let catalog: Vec<SessionConfigSelect> = serde_json::from_value(serde_json::json!([
            {"id": "model", "name": "Model", "category": "model", "currentValue": "opus",
             "options": [{"value": "opus", "name": "Opus", "description": "Big"}, {"value": "sonnet", "name": "Sonnet"}]}
        ]))
        .unwrap();
        let none = agent_directive_sources(None, &catalog, &[]);
        assert_eq!(none[0].candidates.iter().map(|c| c.value.as_str()).collect::<Vec<_>>(), ["opus", "sonnet"]);
        // Names only, no descriptions.
        assert_eq!(none[0].candidates[0].description, None);
        assert!(agent_directive_sources(None, &[], &[]).iter().all(|s| s.candidates.is_empty()));
    }

    // draft-text.test.ts
    #[test]
    fn segments_resolve_longest_first_and_strip_punctuation() {
        let files = ["notes.md", "my spaced file.md", "archive/old.md"];
        let is = |p: &str| files.contains(&p);
        assert_eq!(
            extract_mention_paths("read @notes.md and @missing.md, also @archive/old.md.", is),
            ["notes.md", "archive/old.md"]
        );
        assert_eq!(extract_mention_paths("summarize @my spaced file.md please", is), ["my spaced file.md"]);
        assert_eq!(extract_mention_paths("mail a@notes.md", is), Vec::<String>::new());
        let segs = segment_mentions("see @notes.md.", is);
        assert_eq!(
            segs,
            vec![
                MentionSegment::Text("see ".into()),
                MentionSegment::Mention("notes.md".into()),
                MentionSegment::Text(".".into())
            ]
        );
    }

    // mention-context-parts.test.ts
    #[test]
    fn mention_context_parts_link_real_files_only() {
        let ws = "/ws-mention-context";
        let files = ["notes.md", "readme.md", "archive/old.md", "my spaced file.md"];
        let is = |p: &str| files.contains(&p);
        let parts = mention_context_parts(ws, "read @notes.md and @missing.md, also @archive/old.md.", is);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].path, format!("file://{ws}/notes.md"));
        assert_eq!(parts[0].name.as_deref(), Some("notes.md"));
        assert_eq!(parts[1].path, format!("file://{ws}/archive/old.md"));
        assert!(mention_context_parts(ws, "see @archive", is).is_empty());
        assert!(mention_context_parts(ws, "no refs", is).is_empty());
        let spaced = mention_context_parts(ws, "summarize @my spaced file.md please", is);
        assert_eq!(spaced[0].path, format!("file://{ws}/my%20spaced%20file.md"));
    }

    #[test]
    fn a_typed_model_directive_resolves_against_claudes_real_choices() {
        let option: SessionConfigSelect = serde_json::from_value(serde_json::json!({
            "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "opus",
            "options": [{"value": "default", "name": "Default (recommended)"}, {"value": "opus", "name": "Opus 5.5"},
                        {"value": "haiku", "name": "Haiku 5.5"}, {"value": "claude-haiku-4-5-20251001", "name": "Haiku 4.5"}]
        }))
        .unwrap();
        let sources = agent_directive_sources(None, &[option], &[]);
        let (text, config, _) = resolve_directives("@model:haiku Append exactly one line \"- added live\" to README.md.", &sources);
        assert_eq!(config.len(), 1, "{text}");
        assert!(text.starts_with("Append"), "{text}");
    }
}
