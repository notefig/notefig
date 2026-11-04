//! `notefig [folder]` — open a folder (or restore the last workspace).

use std::path::PathBuf;


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

fn main() {
    let level = match std::env::var("NOTEFIG_LOG").as_deref() {
        Ok("debug") => log::LevelFilter::Debug,
        Ok("info") => log::LevelFilter::Info,
        _ => log::LevelFilter::Warn,
    };
    let _ = log::set_boxed_logger(Box::new(StderrLogger(level))).map(|()| log::set_max_level(level));
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
        .map(PathBuf::from);
    let store = notefig_workspace::StateStore::load_default();

    gpui_kit::application()
        .with_assets(gpui_kit::assets::Assets)
        .run(move |cx| {
            notefig_app::init(store, cx);
            if std::env::var_os("NOTEFIG_NO_AGENTS").is_none() {
                let dir = notefig_workspace::StateStore::default_dir()
                    .unwrap_or_else(std::env::temp_dir);
                notefig_app::agents::Agents::boot_default(&dir, cx);
            }
            cx.on_window_closed(|cx, _| {
                if cx.windows().is_empty() {
                    cx.quit();
                }
            })
            .detach();
            match notefig_app::open_main_window(initial, cx) {
                Ok((_window, _)) => {
                    #[cfg(feature = "screenshot")]
                    screenshot::schedule(_window, cx);
                }
                Err(err) => {
                    eprintln!("notefig: failed to open the window: {err:#}");
                    cx.quit();
                }
            }
            cx.activate(true);
            let _ = cx.refresh_windows();
        });
}

/// `NOTEFIG_SCREENSHOT=<png>`: after `NOTEFIG_SCREENSHOT_DELAY_MS` (2000),
/// render the window's last frame to the file and quit. GPUI draws the scene
/// into a texture, so this needs no Screen Recording permission.
#[cfg(feature = "screenshot")]
mod screenshot {
    use std::time::Duration;

    pub fn schedule(window: gpui::AnyWindowHandle, cx: &mut gpui::App) {
        let Some(path) = std::env::var_os("NOTEFIG_SCREENSHOT") else {
            return;
        };
        let delay = std::env::var("NOTEFIG_SCREENSHOT_DELAY_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(2000);
        cx.spawn(async move |cx| {
            cx.background_executor().timer(Duration::from_millis(delay)).await;
            let shot = window.update(cx, |_, window, _| window.render_to_image());
            match shot {
                Ok(Ok(image)) => match image.save(&path) {
                    Ok(()) => eprintln!("notefig: screenshot saved to {}", path.to_string_lossy()),
                    Err(err) => eprintln!("notefig: screenshot failed: {err}"),
                },
                Ok(Err(err)) | Err(err) => eprintln!("notefig: screenshot failed: {err:#}"),
            }
            cx.update(|cx| cx.quit());
        })
        .detach();
    }
}
