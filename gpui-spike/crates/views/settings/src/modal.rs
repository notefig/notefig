//! `settings-modal.tsx` and `settings-section.tsx`: the Settings dialog. A
//! left rail indexes one scroll container in which every section stacks;
//! scrolling lights up the section you are reading (the TS scroll spy), and
//! picking a section in the rail scrolls to it.

use std::rc::Rc;

use gpui::{
    AnyElement, AnyView, App, AppContext as _, Context, ElementId, Entity, FontWeight,
    InteractiveElement, IntoElement, ParentElement, Render, ScrollHandle,
    StatefulInteractiveElement, Styled, Subscription, Window, div, prelude::FluentBuilder as _, px,
};
use notefig_i18n::{Direction, I18nModule, LANGUAGES, t, t_args};
use notefig_telemetry::{TelemetryConsent, TelemetryModule, telemetry_available};
use notefig_ui::{CoreExt, icon, observe, rem, sp, tokens};
use serde_json::json;

use crate::app_settings::{AppSettings, AppSettingsStore, ThemeChoice, keys};
use crate::hotkeys::{HOTKEY_CATALOG, HOTKEY_GROUPS, dictation_hold_key_label, format_for_display};
use crate::widgets::{Button, checkbox, heading, select, setting_row, switch};
use crate::{DebugMode, SectionViews, apply_theme};

/// Every section, in the order they stack. `label` is an i18n key; `icon`
/// a Lucide name.
pub const SETTINGS_SECTIONS: &[(&str, &str, &str)] = &[
    ("general", "general", "settings"),
    ("appearance", "appearance", "palette"),
    ("hotkeys", "hotkeys", "keyboard"),
    ("harnesses", "harnessSettingsTitle", "sparkles"),
    ("usage", "usageSettingsTitle", "chart-no-axes-column"),
    ("privacy", "privacySettings", "shield"),
];

pub const DEFAULT_SETTINGS_SECTION: &str = "general";

/// An unknown section still opens, on General.
pub fn resolve_section(section: Option<&str>) -> usize {
    section.and_then(|s| SETTINGS_SECTIONS.iter().position(|(id, ..)| *id == s)).unwrap_or(0)
}


#[derive(Clone, Copy, PartialEq)]
enum OpenSelect {
    Language,
    Direction,
    Theme,
}

pub struct SettingsModal {
    scroll: ScrollHandle,
    active: usize,
    /// The section the view is held on after opening or a rail click,
    /// until the user scrolls: its top stays on the container's top while
    /// the sections above it settle (the usage charts load late).
    jump: Option<usize>,
    pinned: bool,
    store: Option<AppSettingsStore>,
    /// `useState({ language: "english" })` in TS; the i18n module's when
    /// the root registers it.
    language: String,
    /// The focused workspace (`useFocusedWorkspace`): its project
    /// settings hold the text direction; none on the welcome screen.
    workspace: Option<String>,
    open_select: Option<OpenSelect>,
    /// `UpdaterButton` over the updater module.
    updater: Option<gpui::Entity<notefig_view_updater::UpdaterButton>>,
    harnesses: Option<AnyView>,
    usage: Option<AnyView>,
    /// `SettingsSectionActions` per section id.
    actions: std::collections::HashMap<&'static str, AnyView>,
    _subs: Vec<notefig_core::Subscription>,
    _gpui_subs: Vec<Subscription>,
}

impl SettingsModal {
    pub fn new(section: usize, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let store = AppSettingsStore::from_core(&core);
        let mut subs = Vec::new();
        if let Some(store) = &store {
            let s = store.clone();
            subs.push(observe(cx, move |notify| s.subscribe(move || notify())));
        }
        let language = core.try_use::<I18nModule>().map(|i| i.language()).unwrap_or_else(|| "english".into());
        let (views, action_builders) = cx.try_global::<SectionViews>().map(|v| (v.0.clone(), v.1.clone())).unwrap_or_default();
        let actions = action_builders.iter().map(|(id, b)| (*id, b(window, cx))).collect();
        let harnesses = views.get("harnesses").map(|b| b(window, cx));
        let workspace = core.try_use::<notefig_workspaces::WorkspacesModule>().and_then(|w| w.focused());
        if let Some(ps) = core.try_use::<notefig_project_settings::ProjectSettingsModule>() {
            subs.push(observe(cx, move |notify| ps.subscribe(move || notify())));
        }
        let updater = core
            .try_use::<notefig_updater::UpdaterModule>()
            .map(|_| cx.new(|cx| notefig_view_updater::UpdaterButton::new(window, cx)));
        let usage = views.get("usage").map(|b| b(window, cx));
        Self {
            scroll: ScrollHandle::new(),
            active: section,
            jump: Some(section),
            pinned: true,
            store,
            language,
            workspace,
            open_select: None,
            updater,
            harnesses,
            usage,
            actions,
            _subs: subs,
            _gpui_subs: Vec::new(),
        }
    }

    /// Scroll to a section (`scrollToSection`).
    pub fn show_section(&mut self, ix: usize, cx: &mut Context<Self>) {
        self.active = ix;
        self.jump = Some(ix);
        self.pinned = true;
        cx.notify();
    }

    pub fn active_section(&self) -> &'static str {
        SETTINGS_SECTIONS[self.active].0
    }

    /// The focused workspace's `settings.direction` (project settings).
    fn direction(&self, cx: &App) -> Direction {
        let (Some(ws), Some(ps)) = (&self.workspace, cx.core().try_use::<notefig_project_settings::ProjectSettingsModule>()) else {
            return Direction::Ltr;
        };
        match ps.settings(ws).direction {
            notefig_project_settings::Direction::Rtl => Direction::Rtl,
            notefig_project_settings::Direction::Ltr => Direction::Ltr,
        }
    }

    fn settings(&self) -> (AppSettings, bool) {
        match &self.store {
            Some(s) => (s.settings(), s.is_ready()),
            None => (AppSettings::default(), false),
        }
    }

    /// The scroll spy: the last section whose top has passed the
    /// activation line; the last one once scrolled to the end.
    fn spy(&mut self) {
        if self.pinned {
            return;
        }
        let container = self.scroll.bounds();
        let line = container.top() + px(48.);
        let mut active = 0;
        for ix in 0..SETTINGS_SECTIONS.len() {
            if let Some(b) = self.scroll.bounds_for_item(ix)
                && b.top() + self.scroll.offset().y <= line
            {
                active = ix;
            }
        }
        let max = self.scroll.max_offset().y;
        if max > px(0.) && -self.scroll.offset().y >= max - px(1.) {
            active = SETTINGS_SECTIONS.len() - 1;
        }
        self.active = active;
    }

    fn toggle_select(&mut self, which: OpenSelect, cx: &mut Context<Self>) {
        self.open_select = if self.open_select == Some(which) { None } else { Some(which) };
        cx.notify();
    }

    fn rail_item(&self, ix: usize, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx);
        let (_, label, icon_name) = SETTINGS_SECTIONS[ix];
        let active = self.active == ix;
        div()
            .id(ElementId::Name(format!("settings-rail-{ix}").into()))
            .flex()
            .items_center()
            .gap(sp(2.))
            .px(sp(2.))
            .py(sp(1.5))
            .rounded(tk.radius_md)
            .text_size(tk.text_sm)
            .cursor_pointer()
            .when(active, |d| d.bg(tk.accent).text_color(tk.accent_foreground))
            .when(!active, |d| d.text_color(tk.foreground.opacity(0.8)).hover(|s| s.bg(tk.accent.opacity(0.5))))
            .child(icon(icon_name).size(rem(1.)).text_color(if active { tk.accent_foreground } else { tk.foreground.opacity(0.8) }))
            .child(div().truncate().child(t(label)))
            .on_click(cx.listener(move |this, _, _, cx| this.show_section(ix, cx)))
            .into_any_element()
    }

    /// `SettingsSection`: `space-y-2 py-6`, a rule under all but the last,
    /// which is at least a viewport tall so it too can reach the top.
    fn section(&self, ix: usize, title: Option<String>, body: AnyElement, cx: &App) -> AnyElement {
        let tk = tokens(cx);
        let last = ix == SETTINGS_SECTIONS.len() - 1;
        let actions = self.actions.get(SETTINGS_SECTIONS[ix].0).cloned();
        let viewport = self.scroll.bounds().size.height;
        div()
            .flex()
            .flex_col()
            .gap(sp(2.))
            .py(sp(6.))
            .when(!last, |d| d.border_b_1().border_color(tk.border))
            .when(last && viewport > px(0.), |d| d.min_h(viewport))
            .when(title.is_some() || actions.is_some(), |d| {
                // The header: the title, and the slot for the section's controls.
                d.child(
                    div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .justify_between()
                        .gap(sp(3.))
                        .children(title.map(heading))
                        .children(actions.map(|a| div().flex().flex_wrap().items_center().gap(sp(3.)).child(a))),
                )
            })
            .child(body)
            .into_any_element()
    }

    fn general(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let (settings, ready) = self.settings();
        let tk = tokens(cx).clone();
        let core = cx.core();
        // The welcome screen has no dock to open a tab into.
        let has_dock = self.workspace.is_some();
        let feedback_available = core.try_use::<notefig_feedback::FeedbackModule>().is_some_and(|f| f.available());

        // UpdateSection
        let updater_button = match &self.updater {
            Some(button) => button.clone().into_any_element(),
            None => Button::new("updater", t("updaterCheckForUpdates")).render(cx),
        };
        let version = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(sp(4.))
            .py(sp(2.))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .text_size(tk.text_sm)
                            .font_weight(FontWeight::MEDIUM)
                            .child(format!("Version {}", env!("CARGO_PKG_VERSION"))),
                    )
                    .when(has_dock, |d| {
                        d.child(
                            div()
                                .id("release-notes")
                                .text_size(tk.text_sm)
                                .text_color(tk.primary)
                                .cursor_pointer()
                                .hover(|s| s.underline())
                                .child(t("releaseNotesTitle"))
                                .on_click(|_, window, cx| {
                                    // One navigation: close the modal, open the tab.
                                    crate::close_settings(window, cx);
                                    if let Some(tabs) = cx.core().try_use::<notefig_tabs::TabsModule>() {
                                        tabs.open(
                                            notefig_updater::RELEASE_NOTES_TAB_ID,
                                            notefig_tabs::OpenTabOptions {
                                                intent: notefig_tabs::OpenFileIntent::NewTab,
                                                ..Default::default()
                                            },
                                        );
                                    }
                                }),
                        )
                    }),
            )
            .child(div().flex_none().child(updater_button));
        let store = self.store.clone();
        let auto_updates = div()
            .flex()
            .items_start()
            .gap(sp(3.))
            .py(sp(2.))
            .when(!ready, |d| d.opacity(0.7))
            .child(div().mt(sp(0.5)).child(checkbox(
                "auto-updates",
                settings.auto_update_enabled,
                !ready,
                {
                    let store = store.clone();
                    move |checked, _, cx| {
                        if let Some(s) = &store {
                            s.set(&cx.core().executor(), keys::AUTO_UPDATE_ENABLED, json!(checked));
                        }
                    }
                },
                cx,
            )))
            .child(
                div()
                    .min_w_0()
                    .child(div().text_size(tk.text_sm).font_weight(FontWeight::MEDIUM).child(t("automaticUpdates")))
                    .child(div().text_size(tk.text_sm).text_color(tk.muted_foreground).child(t("automaticUpdatesDesc"))),
            );

        let entity = cx.entity();
        let language = select(
            "language",
            sp(32.),
            &self.language,
            LANGUAGES.iter().map(|(code, key)| (code.to_string(), t(key).into())).collect(),
            self.open_select == Some(OpenSelect::Language),
            {
                let e = entity.clone();
                move |_, cx| e.update(cx, |this, cx| this.toggle_select(OpenSelect::Language, cx))
            },
            {
                let e = entity.clone();
                move |value, _, cx| {
                    if let Some(i18n) = cx.core().try_use::<I18nModule>() {
                        i18n.set_language(&value);
                    }
                    e.update(cx, |this, cx| {
                        this.language = value;
                        this.open_select = None;
                        cx.notify();
                    })
                }
            },
            cx,
        );
        let direction = select(
            "direction",
            sp(40.),
            self.direction(cx).as_str(),
            vec![("ltr".into(), t("leftToRight").into()), ("rtl".into(), t("rightToLeft").into())],
            self.open_select == Some(OpenSelect::Direction),
            {
                let e = entity.clone();
                move |_, cx| e.update(cx, |this, cx| this.toggle_select(OpenSelect::Direction, cx))
            },
            {
                let e = entity.clone();
                move |value, _, cx| {
                    let direction = Direction::parse(&value);
                    let ws = e.update(cx, |this, cx| {
                        this.open_select = None;
                        cx.notify();
                        this.workspace.clone()
                    });
                    // `projectSettings.update(ws, { settings: { direction } })`.
                    let core = cx.core();
                    if let (Some(ws), Some(ps)) = (ws, core.try_use::<notefig_project_settings::ProjectSettingsModule>()) {
                        let mut patch = serde_json::Map::new();
                        patch.insert("settings".into(), json!({ "direction": direction.as_str() }));
                        let update = ps.update(&ws, patch);
                        core.executor().spawn(Box::pin(async move {
                            if let Err(err) = update.await {
                                log::error!("settings: saving the text direction failed: {err:#}");
                            }
                        }));
                    }
                }
            },
            cx,
        );
        let scratchpad = switch(
            "scratchpad-on-startup",
            settings.scratchpad_on_startup,
            !ready,
            {
                let store = store.clone();
                move |v, _, cx| {
                    if let Some(s) = &store {
                        s.set(&cx.core().executor(), keys::SCRATCHPAD_ON_STARTUP, json!(v));
                    }
                }
            },
            cx,
        );
        let dictation = switch(
            "dictation",
            settings.dictation_enabled,
            !ready,
            {
                let store = store.clone();
                move |v, _, cx| {
                    if let Some(s) = &store {
                        s.set(&cx.core().executor(), keys::DICTATION_ENABLED, json!(v));
                    }
                }
            },
            cx,
        );
        let debug_on = cx.try_global::<DebugMode>().is_some_and(|d| d.0);
        let debug = switch(
            "debug-mode",
            debug_on,
            false,
            |v, window, cx| crate::set_debug_mode(v, window, cx),
            cx,
        );
        let _ = window;
        div()
            .flex()
            .flex_col()
            .gap(sp(2.))
            .child(div().child(version).child(auto_updates))
            .child(setting_row(t("language"), t("languageDesc"), language, cx))
            .child(setting_row(t("textDirection"), t("textDirectionDesc"), direction, cx))
            .child(setting_row(t("scratchpadOnStartup"), t("scratchpadOnStartupDesc"), scratchpad, cx))
            .child(setting_row(
                t("dictation"),
                t_args("dictationDesc", &[("key", dictation_hold_key_label())]),
                dictation,
                cx,
            ))
            .child(
                div()
                    .pt(sp(4.))
                    .child(heading(t("advanced")).mb(sp(1.)))
                    .child(setting_row(t("debugMode"), t("debugModeDesc"), debug, cx))
                    .when(feedback_available, |d| {
                        d.child(setting_row(
                            t("feedbackSettingTitle"),
                            t("feedbackSettingDesc"),
                            Button::new("send-feedback", t("sendFeedback"))
                                .on_click(|_, window, cx| {
                                    crate::close_settings(window, cx);
                                    crate::feedback_dialog::open_feedback(window, cx);
                                })
                                .render(cx),
                            cx,
                        ))
                    }),
            )
            .into_any_element()
    }

    fn appearance(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let (settings, _) = self.settings();
        let entity = cx.entity();
        let store = self.store.clone();
        let theme = select(
            "theme",
            sp(32.),
            settings.theme.as_str(),
            vec![
                ("dark".into(), t("dark").into()),
                ("light".into(), t("light").into()),
                ("system".into(), t("system").into()),
            ],
            self.open_select == Some(OpenSelect::Theme),
            {
                let e = entity.clone();
                move |_, cx| e.update(cx, |this, cx| this.toggle_select(OpenSelect::Theme, cx))
            },
            move |value, window, cx| {
                if let Some(choice) = ThemeChoice::parse(&value) {
                    apply_theme(choice, window, cx);
                    if let Some(s) = &store {
                        s.set(&cx.core().executor(), keys::THEME, json!(value));
                    }
                }
                entity.update(cx, |this, cx| {
                    this.open_select = None;
                    cx.notify();
                });
            },
            cx,
        );
        div()
            .flex()
            .flex_col()
            .gap(sp(2.))
            .child(setting_row(t("theme"), t("themeDesc"), theme, cx))
            .into_any_element()
    }

    fn hotkeys(&self, cx: &App) -> AnyElement {
        let tk = tokens(cx);
        let groups = HOTKEY_GROUPS.iter().filter_map(|(group, label)| {
            let entries: Vec<_> = HOTKEY_CATALOG.iter().filter(|e| e.group == *group).collect();
            if entries.is_empty() {
                return None;
            }
            let rows = entries.iter().enumerate().map(|(i, entry)| {
                let chord = entry.display.map(String::from).unwrap_or_else(|| match entry.binding_end {
                    Some(end) => format!("{} – {}", format_for_display(entry.binding), format_for_display(end)),
                    None => format_for_display(entry.binding),
                });
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(sp(4.))
                    .px(sp(3.))
                    .py(sp(2.))
                    .when(i > 0, |d| d.border_t_1().border_color(tk.border))
                    .child(div().min_w_0().truncate().text_size(tk.text_sm).child(t(&format!("hotkeyLabels.{}", entry.label_key))))
                    .child(
                        div()
                            .flex_none()
                            .rounded(px(4.))
                            .border_1()
                            .border_color(tk.border)
                            .bg(tk.muted)
                            .px(sp(1.5))
                            .py(sp(0.5))
                            .font_family(notefig_ui::theme::FONT_MONO)
                            .text_size(tk.text_xs)
                            .text_color(tk.muted_foreground)
                            .child(chord),
                    )
            });
            Some(
                div()
                    .flex()
                    .flex_col()
                    .gap(sp(1.5))
                    .child(
                        div()
                            .text_size(tk.text_xs)
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(tk.muted_foreground)
                            .child(t(label).to_uppercase()),
                    )
                    .child(div().rounded(tk.radius_lg).border_1().border_color(tk.border).children(rows)),
            )
        });
        div()
            .flex()
            .flex_col()
            .gap(sp(4.))
            .child(
                div()
                    .child(heading(t("keyboardShortcuts")))
                    .child(div().text_size(tk.text_sm).text_color(tk.muted_foreground).child(t("hotkeysDescription"))),
            )
            .children(groups)
            .into_any_element()
    }

    fn placeholder(&self, title: Option<&str>, owner: &str, cx: &App) -> AnyElement {
        let tk = tokens(cx);
        div()
            .flex()
            .flex_col()
            .gap(sp(2.))
            .when_some(title, |d, title| d.child(heading(t(title))))
            .child(
                div()
                    .text_size(tk.text_sm)
                    .text_color(tk.muted_foreground)
                    .child(format!("Not composed yet: {owner} registers this section.")),
            )
            .into_any_element()
    }

    fn privacy(&self, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx).clone();
        let (settings, _) = self.settings();
        let available = telemetry_available();
        let store = self.store.clone();
        let apply = move |key: &'static str, checked: bool, cx: &mut App| {
            let Some(store) = &store else { return };
            let s = store.settings();
            let next = TelemetryConsent {
                crash_enabled: if key == keys::CRASH_REPORTING_ENABLED { checked } else { s.crash_reporting_enabled },
                analytics_enabled: if key == keys::ANALYTICS_ENABLED { checked } else { s.analytics_enabled },
            };
            let exec = cx.core().executor();
            let mut install_id = s.telemetry_install_id.clone();
            if (next.crash_enabled || next.analytics_enabled) && install_id.is_none() {
                let id = notefig_telemetry::new_install_id();
                store.set(&exec, keys::TELEMETRY_INSTALL_ID, json!(id));
                install_id = Some(id);
            }
            store.set(&exec, key, json!(checked));
            if let Some(telemetry) = cx.core().try_use::<TelemetryModule>() {
                telemetry.update_consent(next, install_id.as_deref());
            }
        };
        let apply = Rc::new(apply);
        let a1 = apply.clone();
        let crash = switch(
            "crash-reports",
            available && settings.crash_reporting_enabled,
            !available,
            move |v, _, cx| a1(keys::CRASH_REPORTING_ENABLED, v, cx),
            cx,
        );
        let analytics = switch(
            "usage-analytics",
            available && settings.analytics_enabled,
            !available,
            move |v, _, cx| apply(keys::ANALYTICS_ENABLED, v, cx),
            cx,
        );
        div()
            .flex()
            .flex_col()
            .gap(sp(2.))
            .child(heading(t("privacySettings")))
            .when(!available, |d| {
                d.child(div().text_size(tk.text_sm).text_color(tk.muted_foreground).child(t("telemetryDisabledInBuild")))
            })
            .child(setting_row(t("telemetryCrashLabel"), t("telemetryCrashDescription"), crash, cx))
            .child(setting_row(t("telemetryAnalyticsLabel"), t("telemetryAnalyticsDescription"), analytics, cx))
            .into_any_element()
    }
}

impl Render for SettingsModal {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if let Some(ix) = self.jump.filter(|_| self.pinned) {
            match self.scroll.bounds_for_item(ix) {
                Some(item) => {
                    // Child bounds are layout bounds, before the scroll.
                    let offset = self.scroll.offset();
                    let max = self.scroll.max_offset().y;
                    let y = (self.scroll.bounds().top() - item.top()).clamp(-max, px(0.));
                    if (y - offset.y).abs() > px(0.5) {
                        self.scroll.set_offset(gpui::point(offset.x, y));
                        cx.on_next_frame(window, |_, _, cx| cx.notify());
                    }
                }
                None => cx.on_next_frame(window, |_, _, cx| cx.notify()),
            }
        }
        self.spy();
        let tk = tokens(cx).clone();
        let height = window.viewport_size().height * 0.85;
        let rail = (0..SETTINGS_SECTIONS.len()).map(|ix| self.rail_item(ix, cx)).collect::<Vec<_>>();
        let general = self.general(window, cx);
        let appearance = self.appearance(cx);
        let hotkeys = self.hotkeys(cx);
        let harnesses = match &self.harnesses {
            Some(view) => view.clone().into_any_element(),
            None => self.placeholder(Some("harnessSettingsTitle"), "views/agent (HarnessSettings)", cx),
        };
        let usage = match &self.usage {
            Some(view) => view.clone().into_any_element(),
            None => self.placeholder(None, "views/usage (UsageSettings)", cx),
        };
        let privacy = self.privacy(cx);
        let sections = vec![
            self.section(0, Some(t("general")), general, cx),
            self.section(1, Some(t("appearance")), appearance, cx),
            self.section(2, None, hotkeys, cx),
            self.section(3, None, harnesses, cx),
            self.section(4, Some(t("usageSettingsTitle")), usage, cx),
            self.section(5, None, privacy, cx),
        ];
        let rtl = self.direction(cx).is_rtl();
        div()
            .relative()
            .flex()
            .when(rtl, |d| d.flex_row_reverse())
            .h(height)
            .w_full()
            .overflow_hidden()
            .line_height(rem(1.25))
            .text_color(tk.foreground)
            .child(
                div()
                    .w(sp(56.))
                    .flex_none()
                    .h_full()
                    .when(!rtl, |d| d.border_r_1())
                    .when(rtl, |d| d.border_l_1())
                    .border_color(tk.border)
                    .child(div().flex().flex_col().gap(sp(0.5)).px(sp(2.)).py(sp(4.)).children(rail)),
            )
            .child(
                div()
                    .id("settings-scroll")
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .px(sp(6.))
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .on_scroll_wheel(cx.listener(|this, _, _, cx| {
                        this.pinned = false;
                        this.jump = None;
                        cx.notify();
                    }))
                    .children(sections),
            )
            .child(
                div()
                    .id("settings-close")
                    .absolute()
                    .top(sp(4.))
                    .when(!rtl, |d| d.right(sp(4.)))
                    .when(rtl, |d| d.left(sp(4.)))
                    .rounded(px(4.))
                    .opacity(0.7)
                    .hover(|s| s.opacity(1.))
                    .cursor_pointer()
                    .child(icon("x").size(rem(1.)).text_color(tk.foreground))
                    .on_click(|_, window, cx| crate::close_settings(window, cx)),
            )
    }
}

/// A builder for an owner's section view (harnesses, usage).
pub type SectionBuilder = Rc<dyn Fn(&mut Window, &mut App) -> AnyView>;

pub(crate) fn new_modal(section: usize, window: &mut Window, cx: &mut App) -> Entity<SettingsModal> {
    cx.new(|cx| SettingsModal::new(section, window, cx))
}
