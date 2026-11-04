//! The Search sidebar view: workspace full-text search. Results stream in
//! per file from a background search (`Workspace::search`); clicking a match
//! emits `OpenMatch` and the workspace opens the file at it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use gpui::{
    AppContext as _, Context, Entity, EventEmitter, InteractiveElement, IntoElement,
    ParentElement, Render, SharedString, StatefulInteractiveElement as _, Styled, Subscription,
    Task, Window, div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::{ActiveTheme as _, Icon, IconName, Sizable as _, h_flex, v_flex};
use notefig_workspace::{SearchMatch, SearchOptions, Workspace, file_name, parent_rel};

use crate::theme::BrandColors;

pub const SEARCH_DEBOUNCE: Duration = Duration::from_millis(250);

pub enum SearchEvent {
    OpenMatch(SearchMatch),
}

pub struct SearchView {
    ws: Workspace,
    pub input: Entity<InputState>,
    pub case_sensitive: bool,
    pub regex: bool,
    /// Matches grouped by file, in walk order.
    pub results: Vec<(String, Vec<SearchMatch>)>,
    pub searching: bool,
    error: Option<SharedString>,
    collapsed: Vec<String>,
    task: Option<Task<()>>,
    cancel: Option<Arc<AtomicBool>>,
    _sub: Subscription,
}

impl EventEmitter<SearchEvent> for SearchView {}

impl SearchView {
    pub fn new(ws: Workspace, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder("Search in files"));
        let sub = cx.subscribe(&input, |this: &mut Self, _, event: &InputEvent, cx| match event {
            InputEvent::Change => this.schedule(SEARCH_DEBOUNCE, cx),
            InputEvent::PressEnter { .. } => this.schedule(Duration::ZERO, cx),
            _ => {}
        });
        Self {
            ws,
            input,
            case_sensitive: false,
            regex: false,
            results: Vec::new(),
            searching: false,
            error: None,
            collapsed: Vec::new(),
            task: None,
            cancel: None,
            _sub: sub,
        }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |input, cx| input.focus(window, cx));
    }

    pub fn match_count(&self) -> usize {
        self.results.iter().map(|(_, m)| m.len()).sum()
    }

    fn stop(&mut self) {
        if let Some(cancel) = self.cancel.take() {
            cancel.store(true, Ordering::Relaxed);
        }
        self.task = None;
    }

    /// (Re)run the search after `delay`, cancelling any running one.
    pub fn schedule(&mut self, delay: Duration, cx: &mut Context<Self>) {
        self.stop();
        let query = self.input.read(cx).value().to_string();
        if query.trim().is_empty() {
            self.results.clear();
            self.error = None;
            self.searching = false;
            cx.notify();
            return;
        }
        let options = SearchOptions {
            regex: self.regex,
            case_sensitive: self.case_sensitive,
            max_results: None,
        };
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancel = Some(cancel.clone());
        let ws = self.ws.clone();
        self.task = Some(cx.spawn(async move |this, cx| {
            if !delay.is_zero() {
                cx.background_executor().timer(delay).await;
            }
            let _ = this.update(cx, |this, cx| {
                this.results.clear();
                this.error = None;
                this.searching = true;
                cx.notify();
            });
            let (tx, rx) = async_channel::unbounded::<Vec<SearchMatch>>();
            let search = cx.background_executor().spawn(async move {
                ws.search(&query, &options, &cancel, |batch| tx.send_blocking(batch).is_ok())
            });
            while let Ok(batch) = rx.recv().await {
                let rel = batch[0].rel.clone();
                if this
                    .update(cx, |this, cx| {
                        this.results.push((rel, batch));
                        cx.notify();
                    })
                    .is_err()
                {
                    return;
                }
            }
            let result = search.await;
            let _ = this.update(cx, |this, cx| {
                this.searching = false;
                if let Err(err) = result {
                    this.error = Some(format!("{err:#}").into());
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn toggle(&mut self, regex: bool, cx: &mut Context<Self>) {
        if regex {
            self.regex = !self.regex;
        } else {
            self.case_sensitive = !self.case_sensitive;
        }
        self.schedule(Duration::ZERO, cx);
    }

    fn render_match(&self, ix: usize, m: &SearchMatch, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme();
        let highlight = BrandColors::get(cx).highlight;
        let chars: Vec<char> = m.line_content.chars().collect();
        let start = m.start_column.saturating_sub(1).min(chars.len());
        let end = m.end_column.saturating_sub(1).clamp(start, chars.len());
        // Keep some context before the match; trim leading whitespace.
        let from = start.saturating_sub(24);
        let before: String = chars[from..start].iter().collect::<String>().trim_start().to_string();
        let before = if from > 0 { format!("…{before}") } else { before };
        let matched: String = chars[start..end].iter().collect();
        let after: String = chars[end..].iter().take(120).collect();
        let m2 = m.clone();
        h_flex()
            .id(SharedString::from(format!("search-match-{}-{ix}", m.rel)))
            .pl(px(28.))
            .pr_2()
            .h(px(22.))
            .text_xs()
            .whitespace_nowrap()
            .overflow_hidden()
            .cursor_pointer()
            .hover(|this| this.bg(theme.list_hover))
            .child(div().text_color(theme.muted_foreground).child(before))
            .child(
                div()
                    .bg(highlight.opacity(0.55))
                    .text_color(theme.foreground)
                    .rounded_sm()
                    .child(matched),
            )
            .child(div().text_color(theme.muted_foreground).child(after))
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(SearchEvent::OpenMatch(m2.clone()))))
    }
}

impl Render for SearchView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let files = self.results.len();
        let total = self.match_count();
        let summary: Option<String> = if let Some(err) = &self.error {
            Some(err.to_string())
        } else if self.searching && total == 0 {
            Some("Searching…".into())
        } else if !self.input.read(cx).value().trim().is_empty() {
            Some(match total {
                0 => "No results".into(),
                n => format!(
                    "{n} result{} in {files} file{}{}",
                    if n == 1 { "" } else { "s" },
                    if files == 1 { "" } else { "s" },
                    if self.searching { "…" } else { "" }
                ),
            })
        } else {
            None
        };
        let mut groups = Vec::new();
        for (rel, matches) in &self.results {
            let collapsed = self.collapsed.contains(rel);
            let toggle_rel = rel.clone();
            groups.push(
                h_flex()
                    .id(SharedString::from(format!("search-file-{rel}")))
                    .px_2()
                    .h(px(24.))
                    .gap_1()
                    .text_sm()
                    .cursor_pointer()
                    .hover(|this| this.bg(theme.list_hover))
                    .child(
                        Icon::new(if collapsed { IconName::ChevronRight } else { IconName::ChevronDown })
                            .xsmall(),
                    )
                    .child(Icon::new(IconName::FileText).xsmall().text_color(theme.muted_foreground))
                    .child(div().child(file_name(rel).to_string()))
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .child(parent_rel(rel).to_string()),
                    )
                    .child(
                        div()
                            .text_xs()
                            .px_1()
                            .rounded_sm()
                            .bg(theme.muted)
                            .child(matches.len().to_string()),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(ix) = this.collapsed.iter().position(|r| *r == toggle_rel) {
                            this.collapsed.remove(ix);
                        } else {
                            this.collapsed.push(toggle_rel.clone());
                        }
                        cx.notify();
                    }))
                    .into_any_element(),
            );
            if !collapsed {
                for (ix, m) in matches.iter().enumerate() {
                    groups.push(self.render_match(ix, m, cx).into_any_element());
                }
            }
        }
        v_flex()
            .size_full()
            .child(
                h_flex()
                    .px_2()
                    .pb_2()
                    .gap_1()
                    .child(div().flex_1().child(Input::new(&self.input).small()))
                    .child(
                        Button::new("search-case")
                            .label("Aa")
                            .ghost()
                            .xsmall()
                            .toggled(self.case_sensitive)
                            .tooltip("Match case")
                            .on_click(cx.listener(|this, _, _, cx| this.toggle(false, cx))),
                    )
                    .child(
                        Button::new("search-regex")
                            .label(".*")
                            .ghost()
                            .xsmall()
                            .toggled(self.regex)
                            .tooltip("Use regular expression")
                            .on_click(cx.listener(|this, _, _, cx| this.toggle(true, cx))),
                    ),
            )
            .when_some(summary, |this, summary| {
                this.child(
                    div()
                        .px_3()
                        .pb_1()
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .child(summary),
                )
            })
            .child(
                v_flex()
                    .id("search-results")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .children(groups),
            )
    }
}
