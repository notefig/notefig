//! `StatusBar` (components/editor/status-bar.tsx): save state, word count
//! and the tunnel pill, pinned to the window's bottom corner at the reading
//! direction's end.

use std::time::Duration;

use gpui::{AnyView, Context, IntoElement, ParentElement, Render, Styled, Task, Window, div, prelude::FluentBuilder as _};
use notefig_core::Subscription;
use notefig_documents::DocumentsModule;
use notefig_editors::EditorsModule;
use notefig_tabs::{TabsModule, file_tab_path};
use notefig_i18n::t as tr;
use notefig_ui::{CoreExt as _, icon, observe, rem, sp, tokens};

use crate::panels;

pub struct StatusBar {
    /// Pinned to the reading direction's end: the left corner in RTL.
    rtl: bool,
    /// `useDebouncedSyncState`: "Saved" shows 300 ms after the last write.
    synced: bool,
    debounce: Option<Task<()>>,
    tunnel: Option<AnyView>,
    _subs: Vec<Subscription>,
}

/// Word count, `None` with nothing to count.
pub(crate) fn count_words(content: &str) -> Option<usize> {
    if content.is_empty() {
        return None;
    }
    Some(content.split_whitespace().count())
}

impl StatusBar {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let docs = core.use_::<DocumentsModule>();
        let tabs = core.use_::<TabsModule>();
        let editors = core.use_::<EditorsModule>();
        let d = docs.clone();
        let entity = cx.entity().downgrade();
        let sync_sub = docs.subscribe(move || {
            let _ = &d;
        });
        drop(sync_sub);
        let d2 = docs.clone();
        let subs = vec![
            observe(cx, move |notify| tabs.subscribe(move || notify())),
            observe(cx, move |notify| editors.subscribe(move || notify())),
            observe(cx, move |notify| d2.subscribe(move || notify())),
        ];
        let _ = entity;
        let tunnel = panels(cx).tunnel_pill.map(|ctor| ctor(window, cx));
        Self { rtl: false, synced: true, debounce: None, tunnel, _subs: subs }
    }
}

impl StatusBar {
    pub(crate) fn set_rtl(&mut self, rtl: bool) {
        self.rtl = rtl;
    }
}

impl Render for StatusBar {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let core = cx.core();
        let unsaved = core.use_::<DocumentsModule>().any_unsaved();
        if unsaved {
            self.synced = false;
            self.debounce = None;
        } else if !self.synced && self.debounce.is_none() {
            self.debounce = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(Duration::from_millis(300)).await;
                let _ = this.update(cx, |this, cx| {
                    this.synced = true;
                    this.debounce = None;
                    cx.notify();
                });
            }));
        }
        let active = core.use_::<TabsModule>().active_tab_id();
        let content = file_tab_path(active.as_deref())
            .and_then(|p| core.use_::<EditorsModule>().get(p).text())
            .unwrap_or_default();
        let words = count_words(&content);
        let synced = self.synced;
        div()
            .absolute()
            .bottom_0()
            .when(!self.rtl, |d| d.right_0())
            .when(self.rtl, |d| d.left_0())
            .flex()
            .items_center()
            .gap(sp(4.))
            .px(sp(4.))
            .py(sp(1.5))
            .bg(t.secondary.opacity(0.8))
            .border_t_1()
            .border_color(t.border)
            .when(!self.rtl, |d| d.border_l_1().rounded_tl(t.radius_lg))
            .when(self.rtl, |d| d.border_r_1().rounded_tr(t.radius_lg))
            .text_size(t.text_xs)
            .line_height(t.leading_xs)
            .text_color(t.muted_foreground)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .gap(sp(2.))
                    .min_w(rem(4.5))
                    .child(if synced {
                        icon("cloud").text_color(t.success)
                    } else {
                        icon("cloud-upload").text_color(t.warning)
                    })
                    .child(if synced { tr("saved") } else { tr("saving") }),
            )
            .when_some(words, |d, n| {
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap(sp(2.))
                        .w(rem(6.5))
                        .child(icon("type").text_color(t.muted_foreground))
                        .child(format!("{n} {}", if n == 1 { tr("word") } else { tr("words") })),
                )
            })
            .when_some(self.tunnel.clone(), |d, v| d.child(v))
            .when(self.tunnel.is_none(), |d| {
                // Until the tunnel crate's pill is handed in: its idle face.
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap(sp(2.))
                        .child(icon("monitor-smartphone").text_color(t.muted_foreground))
                        .child(tr("tunnelConnectMachine")),
                )
            })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn counts_words_like_ts() {
        assert_eq!(super::count_words(""), None);
        assert_eq!(super::count_words("  one two\nthree "), Some(3));
    }
}
