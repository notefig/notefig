//! The debug panel (`components/debug-panel.tsx`), reachable through
//! Settings → Advanced → Debug mode. In TS it docks at the bottom of the
//! window (`max-h-[40vh]`); here it opens as a bottom sheet until the shell
//! mounts [`DebugPanel`] itself.
//!
//! Ported: the State / Console / Session tabs, the toolbar (copy debug
//! report, reset telemetry consent, close), the URL row (the `url`
//! service's location: editable, Enter or → navigates, with a decoded
//! preview), and the State tab's route, open tabs, dockable layout and git
//! status cache rows (`crate::debug_report`, the report's format too).
//! Not ported, with reasons:
//! - navigating only replaces the search: the app's one surface is "/";
//! - console capture hooks the `log` crate instead of `console`: the root
//!   wraps its logger in [`capturing_logger`]; without that, the Console tab
//!   says so. Its filter matches text, not a regex;
//! - "Copy Plate AST" and "Reload page": no Plate editor, no page.
//! - the Session tab's transcript and recording: the agents owner's store.

use gpui::{
    App, AppContext as _, ClipboardItem, Context, Entity, FontWeight, InteractiveElement,
    IntoElement, ParentElement, Render, SharedString, StatefulInteractiveElement, Styled, Window,
    div, prelude::FluentBuilder as _, px,
};
use gpui_kit::component::{Placement, WindowExt as _};
use notefig_telemetry::SETTINGS_NAMESPACE;
use notefig_ui::{CoreExt, IconButton, rem, sp, tokens};

// ── Console capture (`useConsoleCapture`) ──

const MAX_CONSOLE_ENTRIES: usize = 500;

/// `"log" | "info" | "warn" | "error"`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConsoleLevel {
    Log,
    Info,
    Warn,
    Error,
}

impl ConsoleLevel {
    const ALL: [ConsoleLevel; 4] = [ConsoleLevel::Log, ConsoleLevel::Info, ConsoleLevel::Warn, ConsoleLevel::Error];
    fn name(self) -> &'static str {
        match self {
            ConsoleLevel::Log => "log",
            ConsoleLevel::Info => "info",
            ConsoleLevel::Warn => "warn",
            ConsoleLevel::Error => "error",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ConsoleEntry {
    pub id: u64,
    pub level: ConsoleLevel,
    /// Seconds since the Unix epoch.
    pub timestamp: u64,
    pub message: String,
}

#[derive(Default)]
struct Console {
    capturing: bool,
    installed: bool,
    next: u64,
    entries: std::collections::VecDeque<ConsoleEntry>,
}

// The capture sits under the process's logger, which is global by nature.
static CONSOLE: std::sync::Mutex<Option<Console>> = std::sync::Mutex::new(None);

fn console<R>(f: impl FnOnce(&mut Console) -> R) -> R {
    let mut guard = CONSOLE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(Console::default))
}

/// Wrap the app's logger so the debug panel's Console tab can capture what
/// it logs (only while capturing, as TS patches `console` only then).
pub fn capturing_logger(inner: Box<dyn log::Log>) -> Box<dyn log::Log> {
    console(|c| c.installed = true);
    Box::new(CapturingLogger { inner })
}

struct CapturingLogger {
    inner: Box<dyn log::Log>,
}

impl log::Log for CapturingLogger {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        self.inner.enabled(meta) || console(|c| c.capturing)
    }
    fn log(&self, record: &log::Record) {
        if self.inner.enabled(record.metadata()) {
            self.inner.log(record);
        }
        console(|c| {
            if !c.capturing {
                return;
            }
            let level = match record.level() {
                log::Level::Error => ConsoleLevel::Error,
                log::Level::Warn => ConsoleLevel::Warn,
                log::Level::Info => ConsoleLevel::Info,
                _ => ConsoleLevel::Log,
            };
            c.next += 1;
            let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
            c.entries.push_back(ConsoleEntry { id: c.next, level, timestamp, message: format!("[{}] {}", record.target(), record.args()) });
            while c.entries.len() > MAX_CONSOLE_ENTRIES {
                c.entries.pop_front();
            }
        });
    }
    fn flush(&self) {
        self.inner.flush();
    }
}

fn console_entries() -> Vec<ConsoleEntry> {
    console(|c| c.entries.iter().cloned().collect())
}

use crate::debug_report::{
    DebugSnapshot, ReportConsoleEntry, debug_snapshot, decode_uri_component, display_params, format_debug_report,
    git_rows_text, hh_mm_ss, iso_time,
};

#[derive(Clone, Copy, PartialEq)]
enum Tab {
    State,
    Console,
    Session,
}

pub struct DebugPanel {
    tab: Tab,
    copied: bool,
    levels: [bool; 4],
    filter: Entity<gpui_kit::component::input::InputState>,
    /// The URL row's draft (`urlDraft`).
    url: Entity<gpui_kit::component::input::InputState>,
    /// The location the draft last took (it follows the URL while unfocused).
    url_synced: Option<String>,
    show_layout: bool,
    _subs: Vec<gpui::Subscription>,
    _url: Option<notefig_core::Subscription>,
    _poll: gpui::Task<()>,
}

impl DebugPanel {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let filter = cx.new(|cx| gpui_kit::component::input::InputState::new(window, cx).placeholder("Filter..."));
        let url = cx.new(|cx| gpui_kit::component::input::InputState::new(window, cx));
        let subs = vec![cx.subscribe_in(&url, window, |this, _, event: &gpui_kit::component::input::InputEvent, window, cx| {
            match event {
                gpui_kit::component::input::InputEvent::PressEnter { .. } => this.navigate(window, cx),
                gpui_kit::component::input::InputEvent::Change => cx.notify(),
                _ => {}
            }
        })];
        // The route changing re-renders (the draft follows it unless typed in).
        let location = cx.core().try_use::<notefig_layout::LayoutModule>().map(|l| l.url().clone());
        let url_sub = location.map(|location| notefig_ui::observe(cx, move |notify| location.subscribe(Box::new(move || notify()))));
        // `scheduleFlush`: re-render while capturing; the State tab re-reads
        // the git cache now and then (TS re-renders on query cache events).
        let poll = cx.spawn(async move |this, cx| {
            let mut tick = 0u32;
            loop {
                cx.background_executor().timer(std::time::Duration::from_millis(200)).await;
                tick += 1;
                let capturing = console(|c| c.capturing);
                let alive = this.update(cx, |this, cx| {
                    if (capturing && this.tab == Tab::Console) || (this.tab == Tab::State && tick % 5 == 0) {
                        cx.notify()
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        });
        Self {
            tab: Tab::State,
            copied: false,
            levels: [true; 4],
            filter,
            url,
            url_synced: None,
            show_layout: false,
            _subs: subs,
            _url: url_sub,
            _poll: poll,
        }
    }

    /// `navigateToUrl`: go to the draft when it differs from where we are.
    fn navigate(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        let target = self.url.read(cx).value().trim().to_string();
        let Some(location) = cx.core().try_use::<notefig_layout::LayoutModule>().map(|l| l.url().clone()) else { return };
        let current = format!("{}{}", location.pathname(), location.search());
        if target.is_empty() || target == current {
            return;
        }
        let search = target.find('?').map(|i| target[i..].to_string()).unwrap_or_default();
        location.set_search(&search, false);
    }

    /// The URL row (`URL` + input + →, and the decoded preview).
    fn url_row(&mut self, snapshot: &DebugSnapshot, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let t = tokens(cx).clone();
        // `useEffect([searchParams])`: the draft follows the URL unless the
        // field has focus.
        if self.url_synced.as_deref() != Some(snapshot.raw_url.as_str())
            && !gpui::Focusable::focus_handle(self.url.read(cx), cx).is_focused(window)
        {
            let raw = snapshot.raw_url.clone();
            self.url.update(cx, |u, cx| u.set_value(raw.clone(), window, cx));
            self.url_synced = Some(raw);
        }
        let draft = self.url.read(cx).value().to_string();
        let decoded = decode_uri_component(&draft);
        div()
            .flex()
            .flex_col()
            .gap(sp(1.))
            .px(sp(3.))
            .py(sp(1.5))
            .border_b_1()
            .border_color(t.border)
            .bg(t.muted.opacity(0.3))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(sp(1.5))
                    .child(div().flex_none().text_size(rem(0.625)).text_color(t.muted_foreground).child("URL"))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .h(sp(6.))
                            .flex()
                            .items_center()
                            .px(sp(1.5))
                            .rounded(px(4.))
                            .border_1()
                            .border_color(t.border)
                            .bg(t.background)
                            .child(gpui_kit::component::input::Input::new(&self.url).appearance(false)),
                    )
                    .child(
                        IconButton::with_content("debug-url-go", tool_icon("arrow-right", t.muted_foreground))
                            .tooltip("Navigate")
                            .on_click(cx.listener(|this, _, window, cx| this.navigate(window, cx))),
                    ),
            )
            .when(decoded != draft, |d| {
                d.child(
                    div()
                        .pl(sp(7.))
                        .truncate()
                        .text_size(rem(0.625))
                        .text_color(t.muted_foreground)
                        .child(format!("Decoded: {decoded}")),
                )
            })
            .into_any_element()
    }

    /// The State tab: route, open tabs, layout, git status cache.
    fn state_tab(&self, snapshot: &DebugSnapshot, cx: &mut Context<Self>) -> gpui::AnyElement {
        let t = tokens(cx).clone();
        let params = display_params(&snapshot.search_params);
        let section = || div().border_t_1().border_color(t.border).pt(sp(2.)).flex().flex_col().gap(sp(1.));
        let pre = |text: String| {
            div()
                .mt(sp(1.))
                .p(sp(2.))
                .rounded(px(4.))
                .bg(t.muted)
                .border_1()
                .border_color(t.border)
                .text_size(rem(0.625))
                .whitespace_normal()
                .children(text.lines().map(|l| div().child(if l.is_empty() { " ".to_string() } else { l.to_string() })).collect::<Vec<_>>())
        };
        let active = snapshot.active_tab_id.clone();
        let show_layout = self.show_layout;
        div()
            .p(sp(3.))
            .flex()
            .flex_col()
            .gap(sp(2.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(sp(1.))
                    .child(row("Current URL (raw)", snapshot.raw_url.clone(), cx))
                    .child(row("Decoded", decode_uri_component(&snapshot.raw_url), cx))
                    .child(row("basePath", snapshot.base_path.clone().unwrap_or_else(|| "undefined".into()), cx))
                    .child(row("searchParams", if params.is_empty() { "(none)".to_string() } else { params }, cx)),
            )
            .child(
                section()
                    .child(row(
                        format!("openTabs ({})", snapshot.open_tabs.len()),
                        if snapshot.open_tabs.is_empty() { "(none)" } else { "" },
                        cx,
                    ))
                    .children(snapshot.open_tabs.iter().map(|tab| {
                        let is_active = Some(tab) == active.as_ref();
                        div()
                            .ml(sp(4.))
                            .flex()
                            .gap(sp(1.))
                            .text_size(rem(0.6875))
                            .when(is_active, |d| d.text_color(t.foreground).font_weight(FontWeight::MEDIUM))
                            .when(!is_active, |d| d.text_color(t.muted_foreground))
                            .child(tab.clone())
                            .when(is_active, |d| d.child(div().text_color(t.primary).child("(active)")))
                    }))
                    .child(row("activeTabId", active.clone().unwrap_or_else(|| "null".into()), cx)),
            )
            .when(!snapshot.layout.is_empty(), |d| {
                d.child(
                    section()
                        .child(
                            div()
                                .id("debug-layout-toggle")
                                .flex()
                                .items_center()
                                .gap(sp(1.))
                                .text_xs()
                                .text_color(t.muted_foreground)
                                .cursor_pointer()
                                .child(tool_icon(if show_layout { "chevron-down" } else { "chevron-right" }, t.muted_foreground))
                                .child("Dockable Layout")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.show_layout = !this.show_layout;
                                    cx.notify();
                                })),
                        )
                        .when(show_layout, |d| d.child(pre(serde_json::to_string_pretty(&snapshot.layout).unwrap_or_default()))),
                )
            })
            .child(
                section()
                    .child(row(
                        "gitStatus.updatedAt",
                        snapshot.git.updated_at.map(iso_time).unwrap_or_else(|| "(none)".into()),
                        cx,
                    ))
                    .when_some(snapshot.git.error.clone(), |d, error| d.child(row("gitStatus.error", error, cx)))
                    .child(pre(git_rows_text(&snapshot.git))),
            )
            .into_any_element()
    }

    fn console_tab(&self, cx: &mut Context<Self>) -> gpui::AnyElement {
        let t = tokens(cx).clone();
        let (capturing, installed) = console(|c| (c.capturing, c.installed));
        let all = console_entries();
        let filter = self.filter.read(cx).value().to_lowercase();
        let shown: Vec<_> = all
            .iter()
            .filter(|e| self.levels[ConsoleLevel::ALL.iter().position(|l| *l == e.level).unwrap_or(0)])
            .filter(|e| filter.is_empty() || e.message.to_lowercase().contains(&filter))
            .cloned()
            .collect();
        let level_color = |l: ConsoleLevel| match l {
            ConsoleLevel::Error => t.destructive,
            ConsoleLevel::Warn => t.warning,
            ConsoleLevel::Info => t.brand,
            ConsoleLevel::Log => t.foreground,
        };
        let toolbar = div()
            .flex()
            .items_center()
            .gap(sp(1.5))
            .px(sp(3.))
            .py(sp(1.5))
            .border_b_1()
            .border_color(t.border)
            .child(
                IconButton::with_content("console-capture", tool_icon(if capturing { "square" } else { "play" }, t.foreground))
                    .pressed(capturing)
                    .tooltip(if capturing { "Stop capturing" } else { "Start capturing" })
                    .on_click(cx.listener(|_, _, _, cx| {
                        console(|c| c.capturing = !c.capturing);
                        cx.notify();
                    })),
            )
            .child(
                IconButton::with_content("console-clear", tool_icon("trash-2", t.muted_foreground))
                    .tooltip("Clear console")
                    .on_click(cx.listener(|_, _, _, cx| {
                        console(|c| c.entries.clear());
                        cx.notify();
                    })),
            )
            .children(ConsoleLevel::ALL.iter().enumerate().map(|(i, level)| {
                let on = self.levels[i];
                div()
                    .id(gpui::ElementId::Name(format!("console-level-{}", level.name()).into()))
                    .px(sp(1.5))
                    .py(sp(0.5))
                    .rounded(px(4.))
                    .text_size(rem(0.625))
                    .cursor_pointer()
                    .when(on, |d| d.bg(t.accent).text_color(level_color(*level)))
                    .when(!on, |d| d.text_color(t.muted_foreground.opacity(0.5)).line_through())
                    .child(level.name())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.levels[i] = !this.levels[i];
                        cx.notify();
                    }))
            }))
            .child(
                div()
                    .flex_1()
                    .h(sp(6.))
                    .flex()
                    .items_center()
                    .px(sp(1.5))
                    .rounded(px(4.))
                    .border_1()
                    .border_color(t.border)
                    .bg(t.background)
                    .child(gpui_kit::component::input::Input::new(&self.filter).appearance(false)),
            );
        let empty = |text: &str| div().p(sp(4.)).text_center().text_size(rem(0.6875)).text_color(t.muted_foreground).child(text.to_string());
        let body = if !installed {
            empty("Console capture needs the app's logger wrapped in debug_panel::capturing_logger.").into_any_element()
        } else if !capturing && all.is_empty() {
            empty("Press play to start capturing console output").into_any_element()
        } else if shown.is_empty() {
            empty(if all.is_empty() { "No console output captured yet" } else { "No entries match the current filter" }).into_any_element()
        } else {
            div()
                .children(shown.into_iter().map(|e| {
                    div()
                        .flex()
                        .gap(sp(2.))
                        .px(sp(3.))
                        .py(sp(0.5))
                        .border_b_1()
                        .border_color(t.border.opacity(0.5))
                        .when(e.level == ConsoleLevel::Error, |d| d.bg(t.destructive.opacity(0.05)))
                        .when(e.level == ConsoleLevel::Warn, |d| d.bg(t.warning.opacity(0.05)))
                        .child(div().flex_none().text_size(rem(0.625)).text_color(t.muted_foreground).child(hh_mm_ss(e.timestamp)))
                        .child(div().text_size(rem(0.6875)).text_color(level_color(e.level)).child(e.message))
                }))
                .into_any_element()
        };
        div().flex().flex_col().child(toolbar).child(body).into_any_element()
    }
}

/// `formatDebugReport` over the app's state now and the captured console.
pub fn debug_report(cx: &App) -> String {
    let entries = console_entries();
    let console: Vec<_> = entries
        .iter()
        .map(|e| ReportConsoleEntry { level: e.level.name(), timestamp: e.timestamp, message: &e.message })
        .collect();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    format_debug_report(&debug_snapshot(cx), now, &console)
}

fn row(label: impl Into<SharedString>, value: impl Into<SharedString>, cx: &App) -> gpui::Div {
    let t = tokens(cx);
    div()
        .flex()
        .gap(sp(2.))
        .text_size(rem(0.6875))
        .child(div().flex_none().text_color(t.muted_foreground).child(format!("{}:", label.into())))
        // `break-all`: long URLs and paths wrap instead of running off.
        .child(div().flex_1().min_w_0().text_color(t.foreground).child(value.into()))
}

impl Render for DebugPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx).clone();
        let snapshot = debug_snapshot(cx);
        let url_row = self.url_row(&snapshot, window, cx);
        let tab_button = |id: &'static str, label: &'static str, tab: Tab, cx: &mut Context<Self>| {
            let active = self.tab == tab;
            div()
                .id(id)
                .px(sp(2.))
                .py(sp(0.5))
                .rounded(px(4.))
                .text_size(t.text_xs)
                .cursor_pointer()
                .when(active, |d| d.bg(t.accent).text_color(t.accent_foreground))
                .when(!active, |d| d.text_color(t.muted_foreground))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.tab = tab;
                    cx.notify();
                }))
        };
        let body = match self.tab {
            Tab::State => self.state_tab(&snapshot, cx),
            Tab::Console => self.console_tab(cx),
            Tab::Session => div()
                .p(sp(4.))
                .text_size(rem(0.6875))
                .text_color(t.muted_foreground)
                .child("No agent session in this workspace yet.")
                .into_any_element(),
        };
        let copied = self.copied;
        div()
            .flex()
            .flex_col()
            .size_full()
            // The sheet's body scrolls; only the panel's own body should:
            // the toolbar and URL row stay put (`ScrollArea flex-1`).
            .min_h_0()
            .bg(t.card.opacity(0.95))
            .font_family(notefig_ui::theme::FONT_MONO)
            .text_size(t.text_xs)
            .text_color(t.foreground)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(sp(2.))
                    .px(sp(3.))
                    .py(sp(1.5))
                    .border_b_1()
                    .border_color(t.border)
                    .bg(t.muted.opacity(0.5))
                    .child(
                        div()
                            .flex()
                            .gap(sp(1.))
                            .child(tab_button("debug-tab-state", "State", Tab::State, cx))
                            .child(tab_button("debug-tab-console", "Console", Tab::Console, cx))
                            .child(tab_button("debug-tab-session", "Session", Tab::Session, cx)),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(sp(1.))
                            .child(
                                IconButton::with_content("debug-copy", tool_icon(if copied { "check" } else { "copy" }, if copied { t.success } else { t.muted_foreground }))
                                    .tooltip("Copy debug report to clipboard")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        cx.write_to_clipboard(ClipboardItem::new_string(debug_report(cx)));
                                        this.copied = true;
                                        cx.notify();
                                    })),
                            )
                            .child(
                                IconButton::with_content("debug-reset-consent", tool_icon("shield-off", t.muted_foreground))
                                    .tooltip("Reset telemetry consent (shows the first-run dialog again)")
                                    .on_click(|_, window, cx| {
                                        let core = cx.core();
                                        if let Some(kv) = core.try_use::<notefig_kv::KvModule>() {
                                            for key in ["telemetryConsentVersion", "crashReportingEnabled", "analyticsEnabled", "telemetryInstallId"] {
                                                core.executor().spawn(Box::pin({
                                                    let f = kv.remove(SETTINGS_NAMESPACE, key);
                                                    async move {
                                                        let _ = f.await;
                                                    }
                                                }));
                                            }
                                        }
                                        crate::consent::show_consent_dialog(window, cx);
                                    }),
                            )
                            .child(
                                IconButton::with_content("debug-close", tool_icon("x", t.muted_foreground))
                                    .tooltip("Close debug panel")
                                    .on_click(|_, window, cx| crate::set_debug_mode(false, window, cx)),
                            ),
                    ),
            )
            .child(url_row)
            .child(div().id("debug-body").flex_1().min_h_0().overflow_y_scroll().child(body))
            .child(div().hidden().font_weight(FontWeight::NORMAL))
    }
}

fn tool_icon(name: &str, color: gpui::Hsla) -> gpui::AnyElement {
    notefig_ui::icon(name).size(sp(3.)).text_color(color).into_any_element()
}

struct Panels(std::collections::HashMap<gpui::WindowId, Entity<DebugPanel>>);
impl gpui::Global for Panels {}

pub fn open_debug_panel(window: &mut Window, cx: &mut App) {
    let id = window.window_handle().window_id();
    if !cx.has_global::<Panels>() {
        cx.set_global(Panels(Default::default()));
    }
    let panel = match cx.global::<Panels>().0.get(&id).cloned() {
        Some(p) => p,
        None => {
            let p = cx.new(|cx| DebugPanel::new(window, cx));
            cx.global_mut::<Panels>().0.insert(id, p.clone());
            p
        }
    };
    let height = window.viewport_size().height * 0.4;
    window.open_sheet_at(Placement::Bottom, cx, move |sheet, _, _| sheet.size(height).p_0().child(panel.clone()));
}

pub fn close_debug_panel(window: &mut Window, cx: &mut App) {
    if window.has_active_sheet(cx) {
        window.close_sheet(cx);
    }
}
