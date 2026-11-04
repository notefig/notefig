//! The prompt composer shared by the chat tab and the in-document widget:
//! a small block editor (Enter sends, Shift+Enter breaks), `@file` mention
//! suggestions, and directive parsing (`@model:x`, `@effort:x`,
//! `@skill:x`) into `PromptExtras`.

use std::path::Path;

use gpui::{
    AppContext as _, Context, Entity, EventEmitter, InteractiveElement, IntoElement, KeyDownEvent,
    ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled, Subscription,
    Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::{ActiveTheme as _, h_flex, v_flex};
use markdown_editor::{BlockEditorEvent, BlockEditorState, SubmitPolicy};
use notefig_agent::prompt::{
    ContextPartKind, PromptCommand, PromptConfigChange, PromptContextPart,
};
use notefig_agent::PromptExtras;

use crate::fuzzy;

pub enum ComposerEvent {
    Submit,
    /// Escape with no suggestion list open.
    Cancel,
    Changed,
}

pub struct Composer {
    pub editor: Entity<BlockEditorState>,
    /// Workspace-relative files offered for `@` mentions.
    files: Vec<String>,
    suggestions: Vec<String>,
    selected: usize,
    /// Byte length of the `@token` being completed (incl. `@`).
    token_len: usize,
    placeholder: SharedString,
    _sub: Subscription,
}

impl EventEmitter<ComposerEvent> for Composer {}

impl Composer {
    pub fn new(placeholder: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let editor = cx.new(|cx| {
            let mut state = BlockEditorState::new(window, cx).with_submit_policy(SubmitPolicy::Enter);
            state.set_slash_trigger(false);
            state.set_placeholder(Some(placeholder.to_string().into()), cx);
            state
        });
        let sub = cx.subscribe(&editor, |this: &mut Self, _, event: &BlockEditorEvent, cx| match event {
            BlockEditorEvent::SubmitRequested => {
                if this.suggestions.is_empty() {
                    cx.emit(ComposerEvent::Submit);
                } else {
                    this.accept(cx);
                }
            }
            BlockEditorEvent::Changed { .. } | BlockEditorEvent::SelectionChanged => {
                this.refresh_suggestions(cx);
                cx.emit(ComposerEvent::Changed);
            }
            _ => {}
        });
        Self {
            editor,
            files: Vec::new(),
            suggestions: Vec::new(),
            selected: 0,
            token_len: 0,
            placeholder: placeholder.to_string().into(),
            _sub: sub,
        }
    }

    pub fn set_files(&mut self, files: Vec<String>) {
        self.files = files;
    }

    pub fn text(&self, cx: &gpui::App) -> String {
        self.editor.read(cx).source().trim().to_string()
    }

    pub fn is_empty(&self, cx: &gpui::App) -> bool {
        self.text(cx).is_empty()
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        self.editor.update(cx, |e, cx| {
            let _ = e.set_source(text, cx);
            let _ = e.select_end(cx);
        });
        self.suggestions.clear();
        cx.notify();
    }

    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.set_text("", cx);
    }

    /// Focus a composer's editor.
    pub fn focus(this: &Entity<Composer>, window: &mut Window, cx: &mut gpui::App) {
        let handle = gpui::Focusable::focus_handle(this.read(cx).editor.read(cx), cx);
        window.focus(&handle, cx);
    }

    pub fn suggestions(&self) -> &[String] {
        &self.suggestions
    }

    /// The `@token` right before the caret, if any.
    fn current_token(&self, cx: &gpui::App) -> Option<String> {
        let prefix = self.editor.read(cx).caret_prefix()?.to_string();
        let at = prefix.rfind('@')?;
        let before_ok = at == 0 || prefix[..at].ends_with(char::is_whitespace);
        let token = &prefix[at + 1..];
        (before_ok && !token.contains(char::is_whitespace) && !token.contains(':'))
            .then(|| token.to_string())
    }

    fn refresh_suggestions(&mut self, cx: &mut Context<Self>) {
        match self.current_token(cx) {
            Some(token) => {
                let ranked = fuzzy::rank(&self.files, &token, true, 8);
                self.suggestions = ranked.into_iter().map(|i| self.files[i].clone()).collect();
                self.token_len = token.len() + 1;
            }
            None => self.suggestions.clear(),
        }
        self.selected = self.selected.min(self.suggestions.len().saturating_sub(1));
        cx.notify();
    }

    /// Replace the `@token` with a mention chip of the selected file.
    pub fn accept(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.suggestions.get(self.selected).cloned() else {
            return;
        };
        let len = self.token_len;
        self.editor.update(cx, |e, cx| {
            if let Ok(mut range) = e.capture_suffix(len) {
                let _ = e.replace_captured(&mut range, "", cx);
            }
            let _ = e.insert_mention(&path, cx);
        });
        self.suggestions.clear();
        cx.notify();
    }

    fn on_key(&mut self, event: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        if self.suggestions.is_empty() {
            if key == "escape" {
                cx.emit(ComposerEvent::Cancel);
                cx.stop_propagation();
            }
            return;
        }
        let n = self.suggestions.len();
        match key {
            "up" => self.selected = (self.selected + n - 1) % n,
            "down" => self.selected = (self.selected + 1) % n,
            "tab" | "enter" => self.accept(cx),
            "escape" => self.suggestions.clear(),
            _ => return,
        }
        cx.notify();
        cx.stop_propagation();
    }
}

impl Render for Composer {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let _ = &self.placeholder;
        div()
            .id("composer")
            .relative()
            .w_full()
            .capture_key_down(cx.listener(Self::on_key))
            .child(markdown_editor::component::BlockEditor::new(&self.editor).auto_grow(1, 10))
            .when(!self.suggestions.is_empty(), |this| {
                this.child(
                    v_flex()
                        .absolute()
                        .bottom_full()
                        .left_0()
                        .mb_1()
                        .w(px(360.))
                        .p_1()
                        .rounded_md()
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.popover)
                        .shadow_md()
                        .children(self.suggestions.iter().enumerate().map(|(ix, s)| {
                            h_flex()
                                .id(("mention", ix))
                                .px_2()
                                .py_0p5()
                                .rounded_sm()
                                .text_sm()
                                .when(ix == self.selected, |el| el.bg(theme.list_active))
                                .child(SharedString::from(format!("@{s}")))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.selected = ix;
                                    this.accept(cx);
                                }))
                        })),
                )
            })
    }
}

/// Split a composer message into prompt text + extras: `@model:x`,
/// `@effort:x` become config switches, `@skill:x` a command (all removed
/// from the text); `@path` mentions of existing workspace files ride along
/// as `resource_link`s (and stay in the text).
pub fn compose_message(text: &str, root: &Path) -> (String, PromptExtras) {
    let mut extras = PromptExtras::default();
    let mut words = Vec::new();
    for word in text.split_inclusive(char::is_whitespace) {
        let bare = word.trim_end();
        let tail = &word[bare.len()..];
        if let Some(rest) = bare.strip_prefix('@') {
            if let Some((kind, value)) = rest.split_once(':') {
                let directive = match kind {
                    "model" => Some(("model", value)),
                    "effort" | "thinking" => Some(("thought_level", value)),
                    _ => None,
                };
                if let Some((category, value)) = directive.filter(|(_, v)| !v.is_empty()) {
                    extras.config.push(PromptConfigChange {
                        category: category.into(),
                        value: value.into(),
                    });
                    continue;
                }
                if kind == "skill" && !value.is_empty() {
                    extras.commands.push(PromptCommand { name: value.into() });
                    continue;
                }
            } else {
                let path = rest.trim_end_matches(['.', ',', ';', ')']);
                let abs = root.join(path);
                if !path.is_empty() && abs.is_file() {
                    let uri = format!("file://{}", abs.to_string_lossy());
                    if !extras.context_parts.iter().any(|p| p.path == uri) {
                        extras.context_parts.push(PromptContextPart {
                            kind: ContextPartKind::ResourceLink,
                            path: uri,
                            content: None,
                            name: Some(path.to_string()),
                        });
                    }
                }
            }
        }
        words.push(format!("{bare}{tail}"));
    }
    (words.concat().trim().to_string(), extras)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directives_and_mentions() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        let (text, extras) = compose_message("Fix @a.md please @model:opus @skill:review @nope.md", dir.path());
        assert_eq!(text, "Fix @a.md please @nope.md");
        assert_eq!(extras.config[0].category, "model");
        assert_eq!(extras.config[0].value, "opus");
        assert_eq!(extras.commands[0].name, "review");
        assert_eq!(extras.context_parts.len(), 1);
        assert_eq!(extras.context_parts[0].name.as_deref(), Some("a.md"));
    }
}
