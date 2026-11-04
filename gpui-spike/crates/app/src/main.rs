//! `notefig [folder]` — the desktop app (TS `main.tsx` + `App.tsx`): boot
//! core over the native platform, open the window on the workspace shell,
//! and run `NOTEFIG_SCRIPT` if set.
//!
//! - `NOTEFIG_STATE_DIR`: where app data lives (the db, the session URL).
//!   Defaults to the platform's app-data folder.
//! - `--mcp-stdio-relay <port>`: relay stdio to the app's MCP server and
//!   exit, before any UI (what a harness spawns).
//! - `NOTEFIG_THEME=dark|light`: force an appearance (default: the OS).

mod app_core;
mod platform_ui;

use std::path::PathBuf;
use std::rc::Rc;

use gpui::{AppContext as _, Bounds, Size, TitlebarOptions, WindowBounds, WindowOptions, point, px, size};
use notefig_layout::{MemoryUrl, UrlState};
use notefig_ui::{CoreExt as _, CoreGlobal, GpuiExecutor};

/// Warnings and errors to stderr (`NOTEFIG_LOG=debug` for more).
struct StderrLogger(log::LevelFilter);

impl log::Log for StderrLogger {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        meta.level() <= self.0
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{} {}] {}", record.level(), record.target(), record.args());
        }
    }
    fn flush(&self) {}
}

fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("NOTEFIG_STATE_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/com.notefig.gpui")
    } else {
        home.join(".local/share/notefig-gpui")
    }
}

fn main() {
    let level = match std::env::var("NOTEFIG_LOG").as_deref() {
        Ok("debug") => log::LevelFilter::Debug,
        Ok("info") => log::LevelFilter::Info,
        _ => log::LevelFilter::Warn,
    };
    // Captured for the debug panel's console tab, then to stderr.
    let logger = notefig_view_settings::debug_panel::capturing_logger(Box::new(StderrLogger(level)));
    let _ = log::set_boxed_logger(logger).map(|()| log::set_max_level(level));
    let args: Vec<String> = std::env::args().skip(1).collect();
    // The harness runs `notefig --mcp-stdio-relay <port>` for the app's MCP
    // server: relay stdio to it and exit, before any UI.
    if args.first().map(String::as_str) == Some("--mcp-stdio-relay") {
        let Some(port) = notefig_agent::mcp::relay::relay_port_from_args(&args) else {
            eprintln!("notefig: --mcp-stdio-relay needs a port");
            std::process::exit(2);
        };
        std::process::exit(notefig_agent::mcp::relay_main(port));
    }
    let initial = args
        .iter()
        .find(|a| !a.starts_with('-'))
        .map(|p| std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p)));
    let dir = state_dir();
    if let Err(err) = std::fs::create_dir_all(&dir) {
        eprintln!("notefig: cannot create {}: {err}", dir.display());
    }

    gpui_kit::application().with_assets(notefig_ui::NotefigAssets).run(move |cx| {
        notefig_ui::init(cx);
        markdown_editor::init(cx);
        match std::env::var("NOTEFIG_THEME").as_deref() {
            Ok("dark") => notefig_ui::set_appearance(Some(true), None, cx),
            Ok("light") => notefig_ui::set_appearance(Some(false), None, cx),
            _ => {}
        }

        let executor = GpuiExecutor::new(cx);
        let ui = platform_ui::GpuiPlatformUi::new(cx.to_async());
        let platform = Rc::new(notefig_platform_native::native_platform(dir.clone(), executor.clone(), ui));
        // A bare "/" at boot: `SessionModule` restores the last session's
        // URL from kv and records every change (`modules/session`).
        let url = MemoryUrl::new("");
        let core = match app_core::create_app_core(app_core::desktop_modules(), platform, url as Rc<dyn UrlState>, executor) {
            Ok(core) => core,
            Err(err) => {
                eprintln!("notefig: {err}");
                cx.quit();
                return;
            }
        };
        cx.set_global(CoreGlobal(core.clone()));
        // The Tauri app's data is imported before any module hydrates: run
        // the migration, then boot, then build the UI.
        let migration = core.use_::<notefig_migration::MigrationModule>().run();
        let initial = initial.clone();
        cx.spawn(async move |cx| {
            let outcome = migration.await;
            log::info!("migration: {outcome:?}");
            cx.update(|cx| start(core, initial, cx));
        })
        .detach();
    });
}

/// Boot core and build the UI: every view crate's init, the panels the
/// shell composes, the window.
fn start(core: notefig_core::Core, initial: Option<PathBuf>, cx: &mut gpui::App) {
        // The release-notes tab, on the first launch of a new version
        // (`useReleaseNotesOnUpdate`). Subscribed before boot: the updater
        // announces it during boot.
        let tabs = core.use_::<notefig_tabs::TabsModule>();
        core.hooks()
            .on::<notefig_updater::ReleaseNotesDue, _>(move |_| {
                tabs.open(
                    notefig_tabs::RELEASE_NOTES_TAB_ID,
                    notefig_tabs::OpenTabOptions { intent: notefig_tabs::OpenFileIntent::NewTab, ..Default::default() },
                );
            })
            .detach();
        // Agent writes adopted into an open editor are their round's change
        // (`documents` sits below turn-writes in the crate graph, so the
        // root hands it the attribution).
        let turn_writes = core.use_::<notefig_turn_writes::TurnWritesModule>();
        core.use_::<notefig_documents::DocumentsModule>()
            .set_attribute(Rc::new(move |path, hash| turn_writes.attribute(path, hash).map(|a| a.turn_id)));
        core.boot();

        // Every view crate's actions and key bindings.
        notefig_view_workspace::init(cx);
        notefig_view_search::init(cx);
        notefig_view_git::init(cx);
        notefig_view_usage::init(cx);
        notefig_view_agent::init(cx);
        notefig_view_settings::init(cx);
        notefig_view_command_palette::init(cx);
        notefig_view_tunnel::init(cx);
        notefig_view_app_status::init(cx);
        notefig_view_dictation::init(cx);
        notefig_view_updater::init(cx);
        notefig_view_file_tree::init(cx);
        notefig_view_welcome::init(cx);
        // The words-so-far of a dictation: written by the editors' targets,
        // drawn by the indicator.
        let dictation_preview = notefig_view_dictation::DictationPreview::new();
        let (indicator_preview, target_preview) = (dictation_preview.clone(), dictation_preview);
        // The shell's panels from the shell owner's side (others register
        // theirs below; `set_panels` merges).
        notefig_view_workspace::set_panels(
            notefig_view_workspace::Panels {
                search: Some(Rc::new(|ws, window, cx| {
                    let panel = cx.new(|cx| notefig_view_search::SearchPanel::new(ws, window, cx));
                    // A result opens its file at the match (TS `onSelect`).
                    cx.subscribe(&panel, |_, event: &notefig_view_search::SearchPanelEvent, cx| {
                        let notefig_view_search::SearchPanelEvent::OpenMatch { m, new_tab } = event;
                        let target = notefig_editors::EditorTarget::Search(notefig_editors::SearchTarget {
                            match_text: m.match_text.clone(),
                            line_text: m.line_text.clone(),
                            occurrence: m.occurrence,
                        });
                        let intent = if *new_tab { notefig_tabs::OpenFileIntent::NewTab } else { notefig_tabs::OpenFileIntent::Replace };
                        let reveal = cx.core().use_::<notefig_tabs::TabsModule>().reveal(
                            &m.file_path,
                            target,
                            notefig_tabs::OpenTabOptions { intent, ..Default::default() },
                        );
                        cx.foreground_executor().spawn(async move { let _ = reveal.await; }).detach();
                    })
                    .detach();
                    panel.into()
                })),
                search_focus: Some(Rc::new(|view, pattern, query, window, cx| {
                    if let Ok(panel) = view.clone().downcast::<notefig_view_search::SearchPanel>() {
                        panel.update(cx, |p, cx| p.focus_input(pattern, query, window, cx));
                    }
                })),
                files_start_create: Some(Rc::new(|view, parent, is_dir, window, cx| {
                    if let Ok(panel) = view.clone().downcast::<notefig_view_file_tree::FileTreePanel>() {
                        panel.update(cx, |p, cx| p.start_create(parent, is_dir, window, cx));
                    }
                })),
                workspace_focused: Some(Rc::new(|path, cx| {
                    notefig_view_command_palette::set_active_workspace(cx, path.map(str::to_string));
                })),
                release_notes: Some(Rc::new(|window, cx| {
                    let view = cx.new(|cx| notefig_view_updater::ReleaseNotesView::new(window, cx));
                    let title = view.read(cx).title().to_string();
                    (view.into(), title)
                })),
                tunnel_pill: Some(Rc::new(|window, cx| cx.new(|cx| notefig_view_tunnel::TunnelStatus::new(window, cx)).into())),
                overlays: vec![
                    Rc::new(|window, cx| cx.new(|cx| notefig_view_tunnel::PairDialog::new(window, cx)).into()),
                    Rc::new(move |window, cx| {
                        let preview = indicator_preview.clone();
                        cx.new(|cx| notefig_view_dictation::DictationIndicator::new(Some(preview), window, cx)).into()
                    }),
                    Rc::new(|window, cx| cx.new(|cx| notefig_view_updater::UpdateToasts::new(window, cx)).into()),
                    Rc::new(|window, cx| cx.new(|cx| notefig_view_settings::consent::TelemetryBootstrap::new(window, cx)).into()),
                ],
                round_id_for_turn: Some(Rc::new(|turn| notefig_view_agent::prompt_round_id(turn))),
                // Every document editor is a dictation target (the composers
                // attach their own).
                editor_attachments: vec![Rc::new(move |editor, _path, window, cx| {
                    let api = notefig_view_dictation::dictation(cx)?;
                    let target = notefig_view_dictation::EditorDictationTarget::new(
                        editor.downgrade(),
                        window.window_handle(),
                        target_preview.clone(),
                        cx,
                    );
                    Some(api.attach(Rc::new(target)))
                })],
                running_task_count: Some(Rc::new(|path, cx| {
                    let store = cx.core().use_::<notefig_agents::AgentStoreModule>();
                    store
                        .tasks_for_workspace(path)
                        .iter()
                        .filter(|t| matches!(t.status, notefig_agents::TaskStatus::Running | notefig_agents::TaskStatus::Starting))
                        .count()
                })),
                agent_title: Some(Rc::new(|task_id, cx| {
                    cx.core().use_::<notefig_agents::AgentStoreModule>().task(task_id).map(|t| t.title)
                })),
                git: Some(Rc::new(|ws, window, cx| cx.new(|cx| notefig_view_git::GitPanel::new(ws, window, cx)).into())),
                open_settings: Some(Rc::new(|section, window, cx| notefig_view_settings::open_settings(section, window, cx))),
                toggle_palette: Some(Rc::new(|window, cx| notefig_view_command_palette::toggle(window, cx))),
                ..Default::default()
            },
            cx,
        );
        notefig_view_command_palette::set_open_file_handler(cx, |path, _, cx| {
            cx.core().use_::<notefig_tabs::TabsModule>().open(path, Default::default());
        });
        notefig_view_workspace::set_panels(
            notefig_view_workspace::Panels {
                files: Some(Rc::new(|ws, window, cx| cx.new(|cx| notefig_view_file_tree::FileTreePanel::new(ws, window, cx)).into())),
                welcome: Some(Rc::new(|window, cx| cx.new(|cx| notefig_view_welcome::Welcome::new(window, cx)).into())),
                sessions: Some(Rc::new(|ws, window, cx| cx.new(|cx| notefig_view_agent::SessionsPanel::new(ws, window, cx)).into())),
                chat_tab: Some(Rc::new(|ws, task_id, window, cx| cx.new(|cx| notefig_view_agent::ChatTab::new(ws, task_id, window, cx)).into())),
                install_node_views: Some(Rc::new(|editor, path, window, cx| {
                    let ws = cx
                        .core()
                        .use_::<notefig_workspaces::WorkspacesModule>()
                        .workspace_of(path)
                        .unwrap_or_default();
                    notefig_view_agent::PromptWidgetHost::attach(editor, ws, path.to_string(), window, cx);
                })),
                minimap: Some(Rc::new(notefig_view_agent::prompt_minimap)),
                ..Default::default()
            },
            cx,
        );

        if let Some(path) = initial {
            let open = core.workspace(&path.to_string_lossy()).open();
            cx.foreground_executor()
                .spawn(async move {
                    if let Err(err) = open.await {
                        log::error!("opening the workspace failed: {err:?}");
                    }
                })
                .detach();
        }

        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        // `NOTEFIG_HEADLESS=1`: never show or focus the window, so scripted
        // runs (the driver's `shot:` renders the frame itself) don't take
        // over the screen.
        let headless = std::env::var_os("NOTEFIG_HEADLESS").is_some();
        let bounds = Bounds::centered(None, size(px(1440.), px(900.)), cx);
        let options = WindowOptions {
            show: !headless,
            focus: !headless,
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            window_min_size: Some(Size { width: px(800.), height: px(560.) }),
            titlebar: Some(TitlebarOptions {
                title: Some("Notefig".into()),
                appears_transparent: true,
                // Inside the sidebar's header row (TS `useTrafficLights`).
                traffic_light_position: Some(point(px(24.), px(24.))),
            }),
            ..Default::default()
        };
        match gpui_kit::open_window(options, cx, |window, cx| {
            cx.new(|cx| {
                let mut root = notefig_view_workspace::WorkspaceRoot::new(window, cx);
                if let Some(sub) = notefig_view_settings::watch_theme(window, cx) {
                    root.keep(sub);
                }
                root
            })
        }) {
            Ok((window, _)) => notefig_ui::driver::run_from_env(window, cx),
            Err(err) => {
                eprintln!("notefig: failed to open the window: {err:#}");
                cx.quit();
            }
        }
        if !headless {
            cx.activate(true);
        }
}
