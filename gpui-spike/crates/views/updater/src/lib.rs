//! The updater's views (`components/app-updater.tsx`,
//! `components/release-notes-tab.tsx`):
//!
//! - [`UpdaterButton`]: the settings modal's one updater action, its face
//!   following every updater state (`settings-modal.tsx`'s UpdaterButton).
//! - [`UpdateToasts`]: the update toasts `sonner` showed — an overlay the
//!   shell places in a corner (gpui-kit's notification layer needs its own
//!   window root, which the shell does not use).
//! - [`ReleaseNotesView`]: the bundled release notes, read-only through the
//!   markdown editor (`ReleaseNotesDocument`), for the release-notes tab and
//!   the welcome screen.

use std::rc::Rc;
use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, AppContext as _, ClickEvent, Context, ElementId, Entity, FocusHandle,
    Focusable, FontWeight, Hsla, InteractiveElement, IntoElement, ParentElement, Render, ScrollHandle, SharedString,
    StatefulInteractiveElement, Styled, Transformation, Window, div, percentage, prelude::FluentBuilder as _,
};
use markdown_editor::{BlockEditor, BlockEditorState};
use notefig_i18n::{t, t_args};
use notefig_ui::{CoreExt as _, icon, observe, rem, sp, tokens};
use notefig_updater::{
    AppUpdaterView, ReleaseNotes, UpdateFlow, UpdateNotice, Updater, UpdaterModule, UpdaterStatus, latest_release_notes,
};

pub fn init(_cx: &mut App) {}

/// The updater from core.
pub fn updater(cx: &App) -> Rc<Updater> {
    cx.core().use_::<UpdaterModule>().as_ref().clone()
}

/// `Loader2 animate-spin`.
fn spinner(id: impl Into<ElementId>, color: Hsla) -> AnyElement {
    icon("loader-circle")
        .size(rem(1.))
        .text_color(color)
        .with_animation(id, Animation::new(Duration::from_secs(1)).repeat(), |svg, delta| {
            svg.with_transformation(Transformation::rotate(percentage(delta)))
        })
        .into_any_element()
}

#[derive(Clone, Copy, PartialEq)]
enum Variant {
    Primary,
    Secondary,
}

/// `Button size="sm"` (`h-8 rounded-md px-3 text-sm font-medium`).
fn button(
    id: impl Into<ElementId>,
    variant: Variant,
    leading: Option<AnyElement>,
    label: impl Into<SharedString>,
    disabled: bool,
    on_click: Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>>,
    cx: &App,
) -> AnyElement {
    let tk = tokens(cx);
    let (bg, fg, hover) = match variant {
        Variant::Primary => (tk.primary, tk.primary_foreground, tk.primary.opacity(0.9)),
        Variant::Secondary => (tk.secondary, tk.secondary_foreground, tk.secondary.opacity(0.8)),
    };
    div()
        .id(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .gap(sp(1.5))
        .h(sp(8.))
        .px(sp(3.))
        .rounded(tk.radius_md)
        .bg(bg)
        .text_color(fg)
        .text_size(tk.text_sm)
        .font_weight(FontWeight::MEDIUM)
        .whitespace_nowrap()
        .when(disabled, |d| d.opacity(0.5))
        .when(!disabled, |d| d.cursor_pointer().hover(move |s| s.bg(hover)))
        .children(leading)
        .child(label.into())
        .when_some(on_click.filter(|_| !disabled), |d, f| d.on_click(move |e, w, cx| f(e, w, cx)))
        .into_any_element()
}

/// The button's face for one updater state — pure, so a host can draw it
/// over any [`AppUpdaterView`] (the settings modal, an example).
pub fn updater_button_face(view: &AppUpdaterView, updater: Option<Rc<Updater>>, cx: &App) -> AnyElement {
    let tk = tokens(cx);
    let on = |f: fn(&Rc<Updater>)| -> Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>> {
        let updater = updater.clone()?;
        Some(Box::new(move |_, _, _| f(&updater)))
    };
    let check = on(|u| u.check_now());
    match view.status {
        UpdaterStatus::Checking => button(
            "updater",
            Variant::Secondary,
            Some(spinner("updater-spin", tk.secondary_foreground)),
            t("updaterChecking"),
            true,
            None,
            cx,
        ),
        UpdaterStatus::UpToDate => button(
            "updater",
            Variant::Secondary,
            Some(icon("circle-check").size(rem(1.)).text_color(tk.success).into_any_element()),
            t("updaterUpToDateShort"),
            false,
            check,
            cx,
        ),
        UpdaterStatus::Error => button(
            "updater",
            Variant::Secondary,
            Some(icon("circle-alert").size(rem(1.)).text_color(tk.destructive).into_any_element()),
            t("updaterCheckForUpdates"),
            false,
            check,
            cx,
        ),
        UpdaterStatus::Available => button(
            "updater",
            Variant::Primary,
            Some(icon("download").size(rem(1.)).text_color(tk.primary_foreground).into_any_element()),
            if view.flow == UpdateFlow::Refresh { t("updaterRefresh") } else { t("updaterDownload") },
            false,
            on(|u| u.start_download()),
            cx,
        ),
        UpdaterStatus::Downloading => {
            let percent = view
                .progress
                .total
                .filter(|total| *total > 0)
                .map(|total| ((view.progress.downloaded as f64 / total as f64) * 100.).round() as u64);
            button(
                "updater",
                Variant::Primary,
                Some(spinner("updater-spin", tk.primary_foreground)),
                percent.map(|p| format!("{p}%")).unwrap_or_else(|| t("updaterDownloading")),
                true,
                None,
                cx,
            )
        }
        UpdaterStatus::Ready => button("updater", Variant::Primary, None, t("updaterRestart"), false, on(|u| u.relaunch_now()), cx),
        UpdaterStatus::Idle => button("updater", Variant::Secondary, None, t("updaterCheckForUpdates"), false, check, cx),
    }
}

/// The settings modal's updater action: `cx.new(|cx| UpdaterButton::new(window, cx))`.
/// Its tooltip carries the error, as the TS `title`.
pub struct UpdaterButton {
    updater: Rc<Updater>,
    _sub: notefig_core::Subscription,
}

impl UpdaterButton {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let updater = updater(cx);
        let u = updater.clone();
        let _sub = observe(cx, move |notify| u.subscribe(move || notify()));
        Self { updater, _sub }
    }
}

impl Render for UpdaterButton {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let view = self.updater.view();
        let title: Option<SharedString> =
            (view.status == UpdaterStatus::Error).then(|| view.error.clone().unwrap_or_else(|| t("updaterGenericError")).into());
        div()
            .id("updater-wrap")
            .flex_none()
            .when_some(title, |d, title| {
                d.tooltip(move |window, cx| gpui_kit::component::tooltip::Tooltip::new(title.clone()).build(window, cx))
            })
            .child(updater_button_face(&view, Some(self.updater.clone()), cx))
    }
}

/// One toast's text, description and action label.
pub fn notice_text(notice: &UpdateNotice) -> (String, Option<String>, Option<String>) {
    match notice {
        UpdateNotice::Available { version, flow } => (
            t_args("updaterToastAvailableTitle", &[("version", version)]),
            Some(if *flow == UpdateFlow::Refresh {
                t("updaterToastAvailableDescriptionRefresh")
            } else {
                t("updaterToastAvailableDescription")
            }),
            Some(if *flow == UpdateFlow::Refresh { t("updaterRefresh") } else { t("updaterDownload") }),
        ),
        UpdateNotice::Downloading => (t("updaterToastDownloading"), None, None),
        UpdateNotice::Downloaded => (t("updaterToastDownloaded"), None, None),
        UpdateNotice::ReadyToRestart => (t("updaterToastReadyToRestart"), None, Some(t("updaterRestart"))),
        UpdateNotice::Failed => (t("updaterGenericError"), None, None),
    }
}

/// The update toasts, stacked bottom-right (sonner's default). Persistent
/// ones stay until acted on or closed; the shell renders this as an
/// overlay over the window body.
pub struct UpdateToasts {
    updater: Rc<Updater>,
    _sub: notefig_core::Subscription,
}

impl UpdateToasts {
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        let updater = updater(cx);
        let u = updater.clone();
        let _sub = observe(cx, move |notify| u.subscribe(move || notify()));
        Self { updater, _sub }
    }
}

impl Render for UpdateToasts {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tk = tokens(cx);
        let notices = self.updater.notices();
        div()
            .absolute()
            .bottom(sp(4.))
            .right(sp(4.))
            .flex()
            .flex_col()
            .gap(sp(2.))
            .w(rem(22.))
            .children(notices.into_iter().map(|(id, notice)| {
                let (title, description, action) = notice_text(&notice);
                let updater = self.updater.clone();
                let leading = match notice {
                    UpdateNotice::Downloading => Some(spinner(("toast-spin", id as usize), tk.muted_foreground)),
                    UpdateNotice::Downloaded | UpdateNotice::ReadyToRestart => {
                        Some(icon("circle-check").size(rem(1.)).text_color(tk.success).into_any_element())
                    }
                    UpdateNotice::Failed => {
                        Some(icon("circle-alert").size(rem(1.)).text_color(tk.destructive).into_any_element())
                    }
                    UpdateNotice::Available { .. } => None,
                };
                let act: Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>> = action.as_ref().map(|_| {
                    let u = updater.clone();
                    let notice = notice.clone();
                    Box::new(move |_: &ClickEvent, _: &mut Window, _: &mut App| {
                        u.dismiss_notice(id);
                        match notice {
                            UpdateNotice::ReadyToRestart => u.relaunch_now(),
                            _ => u.start_download(),
                        }
                    }) as Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>
                });
                notefig_ui::card(cx)
                    .id(("update-toast", id as usize))
                    .relative()
                    .flex()
                    .items_center()
                    .gap(sp(2.))
                    .p(sp(4.))
                    .bg(tk.popover)
                    .text_color(tk.popover_foreground)
                    .children(leading)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .flex()
                            .flex_col()
                            .gap(sp(0.5))
                            .child(div().text_size(tk.text_sm).font_weight(FontWeight::MEDIUM).child(title))
                            .when_some(description, |d, desc| {
                                d.child(div().text_size(tk.text_sm).text_color(tk.muted_foreground).child(desc))
                            }),
                    )
                    .when_some(action.zip(act), |d, (label, f)| {
                        d.child(button(("toast-action", id as usize), Variant::Primary, None, label, false, Some(f), cx))
                    })
                    .child(
                        div()
                            .id(("toast-close", id as usize))
                            .absolute()
                            .top(sp(1.))
                            .right(sp(1.))
                            .p(sp(0.5))
                            .rounded(tk.radius_sm)
                            .cursor_pointer()
                            .text_color(tk.muted_foreground)
                            .hover(|s| s.text_color(tk.foreground))
                            .child(icon("x").size(sp(3.)))
                            .on_click(move |_, _, _| updater.dismiss_notice(id)),
                    )
            }))
    }
}

/// `ReleaseNotesDocument` / `ReleaseNotesTab`: the bundled notes rendered
/// read-only through the editor, centred like an open document
/// (`max-w-2xl mx-auto p-4`). Focusable so the tab's keyboard scrolling
/// and pane hotkeys land here.
pub struct ReleaseNotesView {
    notes: ReleaseNotes,
    editor: Option<Entity<BlockEditorState>>,
    scroll: ScrollHandle,
    focus: FocusHandle,
}

impl ReleaseNotesView {
    /// The notes bundled with this build.
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::with_notes(latest_release_notes(), window, cx)
    }

    /// Any notes (the welcome modal, an example).
    pub fn with_notes(notes: ReleaseNotes, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let scroll = ScrollHandle::new();
        let editor = (!notes.markdown.is_empty()).then(|| {
            let scroll = scroll.clone();
            let markdown = notes.markdown.clone();
            cx.new(|cx| {
                let mut state = BlockEditorState::new(window, cx).with_source(&markdown);
                state.set_scroll_handle(scroll);
                state.set_readonly(true, cx);
                state
            })
        });
        Self { notes, editor, scroll, focus: cx.focus_handle() }
    }

    /// The tab's title (`latestReleaseTitle`), or `releaseNotesTitle`.
    pub fn title(&self) -> SharedString {
        self.notes.title.clone().unwrap_or_else(|| t("releaseNotesTitle")).into()
    }
}

impl Focusable for ReleaseNotesView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Render for ReleaseNotesView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tk = tokens(cx);
        let column = div().w_full().max_w(rem(42.)).mx_auto().p(sp(4.)).overflow_hidden();
        let body = match &self.editor {
            Some(editor) => column.child(BlockEditor::new(editor).w_full()).into_any_element(),
            None => column
                .text_size(tk.text_sm)
                .text_color(tk.muted_foreground)
                .child(t("releaseNotesEmpty"))
                .into_any_element(),
        };
        div()
            .id("release-notes")
            .track_focus(&self.focus)
            .size_full()
            .min_w_0()
            .bg(tk.background)
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(body)
    }
}
