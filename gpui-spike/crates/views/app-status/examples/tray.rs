//! Smoke run of the menu-bar item: publishes a status with every glyph,
//! keeps the item up for `TRAY_SECS` (default 2) seconds, then quits.
//! `cargo run -p notefig-view-app-status --example tray`.

use std::time::Duration;

use notefig_app_status::{AppStatus, AppStatusAction, AppStatusActivate, AppStatusEntry, AppStatusModule, AppStatusSection};
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services};
use notefig_platform::PlatformService;
use notefig_platform::fake::FakePlatform;
use notefig_ui::{CoreGlobal, GpuiExecutor, NotefigAssets};

fn entry(id: &str, label: &str, detail: &str, mark: &str) -> AppStatusEntry {
    let what = id.to_string();
    AppStatusEntry {
        id: id.into(),
        label: label.into(),
        detail: Some(detail.into()),
        mark: Some(mark.into()),
        activate: AppStatusActivate::new(move || eprintln!("activated: {what}")),
    }
}

fn main() {
    let secs: u64 = std::env::var("TRAY_SECS").ok().and_then(|s| s.parse().ok()).unwrap_or(2);
    gpui_kit::application().with_assets(NotefigAssets).run(move |cx| {
        let fake = FakePlatform::new();
        let core = Core::new(
            CreateCoreOptions::new(GpuiExecutor::new(cx))
                .services(Services::new().with::<PlatformService>(fake.platform.clone()))
                .modules(vec![ModuleRef::of::<AppStatusModule>()]),
        )
        .expect("core");
        core.boot();
        let api = core.use_::<AppStatusModule>();
        cx.set_global(CoreGlobal(core));
        notefig_view_app_status::init(cx);
        let status = AppStatus {
            attention: Some("attention-bau".into()),
            sections: vec![
                AppStatusSection {
                    id: "prompts".into(),
                    title: "Prompts".into(),
                    entries: vec![
                        entry("prompts:t1", "Tighten the intro", "Running", "running"),
                        entry("prompts:t2", "Fix the table", "notes.md", "done"),
                    ],
                },
                AppStatusSection {
                    id: "sessions".into(),
                    title: "Sessions".into(),
                    entries: vec![
                        entry("sessions:a", "Refactor chapter 3", "book", "attention-bau"),
                        entry("sessions:b", "Failing build", "book", "error"),
                    ],
                },
            ],
            actions: vec![AppStatusAction {
                id: "settings".into(),
                label: "Settings".into(),
                activate: AppStatusActivate::new(|| eprintln!("activated: settings")),
            }],
        };
        api.publish(status);
        eprintln!("menu-bar item up: {:?}", api.current().map(|s| s.sections.len()));
        cx.spawn(async move |cx| {
            cx.background_executor().timer(Duration::from_secs(secs)).await;
            let _ = cx.update(|cx| cx.quit());
        })
        .detach();
    });
}
