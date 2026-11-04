//! The welcome screen: a port of `components/welcome.tsx` (and the small
//! `directory-picker.tsx`), shown when no workspace is open. The title, the
//! one primary action (Open Workspace, the folder picker), recent projects,
//! and a right rail with the current release's notes and the utility strip
//! (docs, GitHub, theme, settings).
//!
//! [`recent`] carries the hooks it stands on (`use-recent-projects`,
//! `use-open-project`), which the shell's rail "+" uses too.

mod picker;
pub mod recent;

use gpui::{
    App, ClickEvent, Context, FocusHandle, Focusable, FontWeight, InteractiveElement, IntoElement, ParentElement,
    Render, SharedString, StatefulInteractiveElement as _, Styled, Window, anchored, deferred, div, point,
    prelude::FluentBuilder as _, px,
};
use notefig_core::Subscription;
use notefig_kv::KvModule;
use notefig_platform::PlatformService;
use notefig_ui::theme::{FONT_MONO, FONT_SERIF};
use notefig_ui::{CoreExt as _, IconButton, icon, rem, sp, tokens};

pub use picker::DirectoryPicker;
pub use recent::{RecentProjectDisplay, add_recent_project, open_project, open_project_from_picker, recent_projects};

/// `useAppSettings`' namespace; `theme` is "light" | "dark" | "system".
const SETTINGS_NAMESPACE: &str = "settings";

pub fn init(_cx: &mut App) {}

/// The welcome screen has no workspace to open a tab in, so it hosts the
/// notes in a modal: the same document the release-notes tab renders.
fn open_release_notes(window: &mut Window, cx: &mut App) {
    use gpui::AppContext as _;
    use gpui_kit::component::WindowExt as _;
    let view = cx.new(|cx| notefig_view_updater::ReleaseNotesView::new(window, cx));
    window.open_dialog(cx, move |dialog, _, _| dialog.width(rem(48.)).child(div().max_h(rem(30.)).child(view.clone())));
}

/// `<Welcome />`.
pub struct Welcome {
    focus: FocusHandle,
    loading: bool,
    theme_menu: bool,
    _subs: Vec<Subscription>,
}

impl Focusable for Welcome {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Welcome {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let kv = cx.core().use_::<KvModule>();
        let rows = kv.collection(recent::RECENT_PROJECTS_NAMESPACE);
        cx.core().executor().spawn(rows.preload());
        let mut subs = vec![notefig_ui::observe(cx, |notify| rows.subscribe(move || notify()))];
        if let Some(agents) = cx.core().try_use::<notefig_agents::AgentsModule>() {
            let store = agents.store();
            subs.push(notefig_ui::observe(cx, |notify| store.subscribe_harnesses(move || notify())));
        }
        let focus = cx.focus_handle();
        // The primary action takes focus, as the TS button does.
        window.focus(&focus, cx);
        Self { focus, loading: false, theme_menu: false, _subs: subs }
    }

    fn open_workspace(&mut self, cx: &mut Context<Self>) {
        if self.loading {
            return;
        }
        self.loading = true;
        cx.notify();
        let open = open_project_from_picker(&cx.core());
        cx.spawn(async move |this, cx| {
            open.await;
            let _ = this.update(cx, |this, cx| {
                this.loading = false;
                cx.notify();
            });
        })
        .detach();
    }

    fn open_external(url: &str, cx: &App) {
        cx.core().service::<PlatformService>().ui.open_external(url);
    }

    fn set_theme(&mut self, choice: Option<bool>, window: &mut Window, cx: &mut Context<Self>) {
        notefig_ui::set_appearance(choice, Some(window), cx);
        let value = match choice {
            Some(true) => "dark",
            Some(false) => "light",
            None => "system",
        };
        let write = cx.core().use_::<KvModule>().write(SETTINGS_NAMESPACE, "theme", &value);
        cx.core().executor().spawn(Box::pin(async move {
            let _ = write.await;
        }));
        self.theme_menu = false;
        cx.notify();
    }

    fn render_recent_row(&self, ix: usize, project: &RecentProjectDisplay, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let path = project.path.clone();
        div()
            .id(("recent", ix))
            .flex()
            .w_full()
            .items_center()
            .gap(sp(3.))
            .px(sp(3.))
            .py(sp(2.5))
            .rounded(t.radius_lg)
            .border_1()
            .border_color(t.border)
            .bg(t.card)
            .cursor_pointer()
            .hover(move |s| s.border_color(t.primary).bg(t.accent))
            .child(div().flex().flex_none().size(sp(7.)).items_center().justify_center().child(gpui::img(gpui::SharedString::from(t.logo_asset())).size(rem(1.75))))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(div().truncate().text_size(t.text_xs).font_weight(FontWeight::MEDIUM).text_color(t.foreground).child(project.name.clone()))
                    .child(div().truncate().font_family(FONT_MONO).text_size(rem(0.6875)).text_color(t.muted_foreground).child(project.path.clone())),
            )
            .child(div().flex_none().text_size(rem(0.6875)).text_color(t.muted_foreground).child(project.last_modified.clone()))
            .on_click(cx.listener(move |_, _: &ClickEvent, _, cx| {
                let open = open_project(&cx.core(), &path);
                cx.core().executor().spawn(Box::pin(async move {
                    open.await;
                }));
            }))
    }

    /// `HarnessPanel`: readiness of the configured harnesses, purely what
    /// the startup discovery already probed. State is the dot and the text
    /// weight, not a label per row. Nothing about models or quotas: those
    /// are session facts. Desktop only (the probe cannot run on the web).
    fn render_harness_panel(&self, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        use notefig_agent::harness::{Availability, harness_settings_rows};
        let agents = cx.core().try_use::<notefig_agents::AgentsModule>()?;
        let t = tokens(cx).clone();
        let rows: std::collections::BTreeMap<String, _> =
            agents.store().harness_rows().into_iter().map(|r| (r.id.clone(), r)).collect();
        let probed: Vec<_> = harness_settings_rows(&rows).into_iter().filter(|r| r.enabled).collect();
        if probed.is_empty() {
            return Some(div().text_size(t.text_xs).text_color(t.muted_foreground).child("No harnesses configured").into_any_element());
        }
        let list = probed.into_iter().map(|row| {
            let found = row.availability == Availability::Found;
            let dot = match row.availability {
                Availability::Found => t.success,
                Availability::Missing => t.muted_foreground.opacity(0.3),
                // "Not checked" is not "missing": keep the column, paint nothing.
                Availability::Unknown => gpui::transparent_black(),
            };
            let color = if found { t.foreground } else { t.muted_foreground };
            div()
                .flex()
                .items_center()
                .gap(sp(2.))
                .text_size(t.text_xs)
                .text_color(color)
                .child(div().flex_none().size(sp(1.5)).rounded_full().bg(dot))
                .child(notefig_view_agent::harness_logo(&row.definition.id, sp(3.), color))
                .child(div().truncate().child(row.definition.label.clone()))
        });
        Some(div().flex().flex_col().gap(sp(1.5)).children(list).into_any_element())
    }

    /// The bundled notes as the rail shows them: up to six list entries on
    /// one line each, then the closing lines, then the link.
    fn render_release_notes(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let notes = notefig_updater::latest_release_notes();
        // A build without notes shows nothing (`ReleaseNotesPanel`).
        if notes.title.is_none() || notes.body.is_empty() {
            return div();
        }
        let inline = |text: &str| {
            // `code` spans in the mono face.
            let mut el = div().flex().min_w_0().overflow_hidden().whitespace_nowrap();
            for (i, part) in text.split('`').enumerate() {
                if !part.is_empty() {
                    el = el.child(if i % 2 == 1 { div().font_family(FONT_MONO).child(part.to_string()) } else { div().child(part.to_string()) });
                }
            }
            el
        };
        let mut list = div().flex().flex_col().gap(sp(1.)).max_h(rem(12.)).overflow_hidden().text_size(t.text_xs).text_color(t.muted_foreground);
        let mut bullets = 0;
        for line in notes.body.lines().filter(|l| !l.trim().is_empty()) {
            if let Some(item) = line.strip_prefix("- ") {
                bullets += 1;
                if bullets <= 6 {
                    list = list.child(
                        div()
                            .flex()
                            .items_center()
                            .gap(sp(2.))
                            .min_w_0()
                            .child(div().flex_none().size(px(5.)).rounded_full().bg(t.muted_foreground.opacity(0.5)))
                            .child(inline(item)),
                    );
                }
            } else {
                list = list.child(inline(line));
            }
        }
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .child(div().mb(sp(2.)).text_size(t.text_xs).font_weight(FontWeight::MEDIUM).text_color(t.foreground).child(format!("v{}", notefig_updater::APP_VERSION)))
            .child(list)
            .child(
                div()
                    .id("release-notes")
                    .mt(sp(2.))
                    .text_size(t.text_xs)
                    .text_color(t.muted_foreground)
                    .underline()
                    .cursor_pointer()
                    .hover(move |s| s.text_color(t.foreground))
                    .child("Release notes")
                    .on_click(|_, window, cx| open_release_notes(window, cx)),
            )
    }

    fn render_rail_buttons(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let muted = t.muted_foreground;
        // `size-6 … lg:size-8`, icons `size-4`.
        let button = move |id: &'static str, name: &'static str, label: &'static str| {
            IconButton::with_content(id, icon(name).size(sp(4.)).text_color(muted).into_any_element()).size(sp(8.), sp(8.)).tooltip(label)
        };
        let weak = cx.entity().downgrade();
        let menu = self.theme_menu.then(|| {
            let item = |id: &'static str, name: &'static str, label: &'static str, choice: Option<bool>| {
                div()
                    .id(id)
                    .flex()
                    .items_center()
                    .gap(sp(2.))
                    .px(sp(2.))
                    .py(sp(1.5))
                    .rounded(t.radius_sm)
                    .text_size(t.text_sm)
                    .text_color(t.popover_foreground)
                    .cursor_pointer()
                    .hover(move |s| s.bg(t.accent))
                    .child(icon(name).size(sp(4.)).text_color(t.popover_foreground))
                    .child(label)
                    .on_click(cx.listener(move |this, _, window, cx| this.set_theme(choice, window, cx)))
            };
            deferred(
                anchored().anchor(gpui::Anchor::BottomRight).offset(point(px(0.), -sp(1.))).child(
                    div()
                        .id("theme-menu")
                        .occlude()
                        .min_w(rem(8.))
                        .p(sp(1.))
                        .rounded(t.radius_md)
                        .border_1()
                        .border_color(t.border)
                        .bg(t.popover)
                        .shadow_md()
                        .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                            this.theme_menu = false;
                            cx.notify();
                        }))
                        .child(item("light", "sun", "Light", Some(false)))
                        .child(item("dark", "moon", "Dark", Some(true)))
                        .child(item("system", "monitor", "System", None)),
                ),
            )
        });
        div()
            .flex()
            .flex_none()
            .items_center()
            .justify_end()
            .gap(sp(0.5))
            .mt(sp(4.))
            .child(button("docs", "book", "Documentation").on_click(|_, _, cx| Self::open_external("https://notefig.com/docs", cx)))
            .child(button("github", "github", "GitHub").on_click(|_, _, cx| Self::open_external("https://github.com/notefig/notefig", cx)))
            .child(
                div()
                    .relative()
                    .child(button("theme", if t.dark { "moon" } else { "sun" }, "Toggle theme").on_click(move |_, _, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.theme_menu = !this.theme_menu;
                            cx.notify();
                        });
                    }))
                    .children(menu),
            )
            .child(button("settings", "settings", "Settings").on_click(|_, window, cx| {
                // The settings view owns the dialog; its action opens it.
                if let Ok(action) = cx.build_action("settings::OpenSettings", None) {
                    window.dispatch_action(action, cx);
                }
            }))
    }
}

impl Render for Welcome {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        // Tailwind's `lg` breakpoint: the rail sits beside, else below.
        let wide = window.viewport_size().width >= px(1024.);
        let projects = recent_projects(&cx.core().use_::<KvModule>(), recent::now_ms());
        let rows: Vec<_> = projects.iter().enumerate().map(|(i, p)| self.render_recent_row(i, p, cx).into_any_element()).collect();
        let focused = self.focus.is_focused(window);
        let label: SharedString = if self.loading { "Opening...".into() } else { "Open Workspace".into() };

        let empty = div()
            .rounded(t.radius_lg)
            .border_1()
            .border_dashed()
            .border_color(t.border)
            .px(sp(4.))
            .py(sp(6.))
            .flex()
            .flex_col()
            .items_center()
            .child(div().text_size(t.text_xs).text_color(t.muted_foreground).child("No recent projects"))
            .child(div().mt(sp(1.)).text_size(rem(0.6875)).text_color(t.muted_foreground).child("Choose a folder to work in"));

        let left = div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .min_w_0()
            .overflow_hidden()
            .px(if wide { sp(10.) } else { sp(7.) })
            .pb(sp(7.))
            .pt(if wide { sp(12.) } else { sp(10.) })
            .child(
                div()
                    .flex_none()
                    .child(
                        div()
                            .font_family(FONT_SERIF)
                            .font_weight(FontWeight::BOLD)
                            .italic()
                            .text_size(rem(3.75))
                            .line_height(rem(3.75))
                            .text_color(t.foreground)
                            .child("Notefig."),
                    )
                    .child(div().mt(sp(3.)).max_w(rem(24.)).text_size(t.text_xs).text_color(t.muted_foreground).child("A better place to write notes, plans and workflows with AI."))
                    .child(
                        div().mt(sp(5.)).flex().child(
                            div()
                                .id("open-workspace")
                                .track_focus(&self.focus)
                                .flex()
                                .items_center()
                                .gap(sp(2.))
                                .h(sp(8.))
                                .px(sp(3.))
                                .rounded(t.radius_md)
                                .bg(t.primary)
                                .text_color(t.primary_foreground)
                                .text_size(t.text_xs)
                                .font_weight(FontWeight::MEDIUM)
                                .cursor_pointer()
                                // `focus-visible:ring-2 ring-ring ring-offset-2`.
                                .when(focused, |d| d.border_2().border_color(t.background).shadow(vec![gpui::BoxShadow {
                                    color: t.ring,
                                    offset: point(px(0.), px(0.)),
                                    blur_radius: px(0.),
                                    spread_radius: px(2.),
                                    inset: false,
                                }]))
                                .when(self.loading, |d| d.opacity(0.5))
                                .hover(|s| s.opacity(0.9))
                                .child(icon("folder-open").size(sp(4.)).text_color(t.primary_foreground))
                                .child(label)
                                .on_click(cx.listener(|this, _, _, cx| this.open_workspace(cx))),
                        ),
                    ),
            )
            .child(div().flex_none().mt(sp(8.)).mb(sp(2.5)).text_size(t.text_xs).font_weight(FontWeight::MEDIUM).text_color(t.foreground).child("Recent"))
            .child(
                div()
                    .id("recent-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(if rows.is_empty() { empty.into_any_element() } else { div().flex().flex_col().gap(sp(1.5)).children(rows).into_any_element() }),
            );

        let rail = div()
            .relative()
            .flex()
            .flex_col()
            .flex_none()
            .min_w_0()
            .when(wide, |d| d.w(rem(20.)).min_h_0().px(sp(5.)).pb(sp(7.)).pt(sp(12.)))
            .when(!wide, |d| d.px(sp(5.)).pb(sp(5.)))
            // A short inset rule, not a full-height border.
            .when(wide, |d| d.child(div().absolute().left_0().top(sp(12.)).bottom(sp(12.)).w(px(1.)).bg(t.border)))
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .flex()
                    .flex_col()
                    .gap(sp(6.))
                    .children(self.render_harness_panel(cx))
                    .child(self.render_release_notes(cx)),
            )
            .child(self.render_rail_buttons(cx));

        div()
            .id("welcome")
            .key_context("Welcome")
            .size_full()
            .flex()
            .when(wide, |d| d.flex_row())
            .when(!wide, |d| d.flex_col())
            .overflow_hidden()
            .bg(t.background)
            .on_key_down(cx.listener(|this, e: &gpui::KeyDownEvent, window, cx| {
                if this.focus.is_focused(window) && (e.keystroke.key == "enter" || e.keystroke.key == "space") {
                    this.open_workspace(cx);
                }
            }))
            .child(left)
            .child(rail)
    }
}
