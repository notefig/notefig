//! The Usage section alone over a core with a month of synthetic usage:
//! `cargo run -p notefig-view-usage --example usage --features screenshot`,
//! driven by `NOTEFIG_SCRIPT`. The usage is announced through the agents'
//! hooks, as the agent runtime does, into the fake platform's db.

use gpui::{AppContext as _, InteractiveElement as _, StatefulInteractiveElement as _, Bounds, Context, Entity, IntoElement, ParentElement, Render, Styled, Window, WindowBounds, WindowOptions, div, px, size};
use notefig_agent::usage::{Cost, CostType, ModelUsage, TokenCounts, TurnUsage, Usage, UsageLimitStatus, UsageLimitWindow, UsageLimits};
use notefig_agents::agent_events::{AgentUsage, AgentUsageEvent, AgentUsageLimits, AgentUsageLimitsEvent};
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services};
use notefig_harness_adapters::HarnessAdaptersModule;
use notefig_platform::PlatformService;
use notefig_platform::fake::FakePlatform;
use notefig_ui::{CoreExt as _, CoreGlobal, GpuiExecutor, NotefigAssets, sp, tokens};
use notefig_usage::UsageModule;
use notefig_view_usage::UsageSettings;

struct Host {
    section: Entity<UsageSettings>,
}

impl Render for Host {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = tokens(cx);
        div()
            .id("host")
            .size_full()
            .bg(t.background)
            .overflow_y_scroll()
            .p(sp(6.))
            .child(div().text_size(t.text_base).font_weight(gpui::FontWeight::SEMIBOLD).text_color(t.foreground).child("Usage"))
            .child(self.section.clone())
    }
}

fn usage(input: f64, output: f64, read: f64, cost: Option<Cost>, models: &[(&str, f64)]) -> TurnUsage {
    let tokens = TokenCounts { input, output, cache_read: read, cache_write: input * 0.1, thought: 0.0 };
    let total = Usage { tokens, cost: cost.clone() };
    let by_model = models
        .iter()
        .enumerate()
        .map(|(i, (m, share))| ModelUsage {
            model: Some(m.to_string()),
            usage: Usage {
                tokens: TokenCounts {
                    input: input * share,
                    output: output * share,
                    cache_read: read * share,
                    cache_write: input * 0.1 * share,
                    thought: 0.0,
                },
                cost: if i == 0 { cost.clone() } else { None },
            },
        })
        .collect();
    TurnUsage { total, by_model }
}

fn seed(core: &Core) {
    let now = chrono::Local::now().timestamp_millis();
    let hour = 3_600_000i64;
    let usd = |a: f64| Some(Cost { amount: a, currency: "USD".into(), kind: CostType::Currency });
    let mut x: u64 = 7;
    let mut rand = move || {
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((x >> 33) % 1000) as f64 / 1000.0
    };
    for day in 0..30i64 {
        for h in [9i64, 10, 11, 14, 15, 16, 17, 21] {
            let at = now - day * 24 * hour - (now % (24 * hour)) + h * hour;
            if at > now || rand() < 0.35 {
                continue;
            }
            let w = 1.0 + (day as f64 / 6.0).sin().abs() * 2.0;
            let emit = |harness: &str, turn: TurnUsage| {
                core.hooks().emit::<AgentUsage>(AgentUsageEvent {
                    task_id: "task".into(),
                    turn_id: "trn".into(),
                    workspace_path: "/ws".into(),
                    harness_id: harness.into(),
                    at,
                    usage: turn,
                });
            };
            let r = rand();
            emit("claude-code", usage(20_000.0 * w * r, 4_000.0 * w, 120_000.0 * w * r, usd(0.4 * w * r), &[("claude-sonnet-4-5", 0.7), ("claude-haiku-4-5", 0.3)]));
            if rand() < 0.6 {
                emit("opencode", usage(15_000.0 * w, 3_000.0, 40_000.0 * rand(), usd(0.2 * w), &[("gpt-5", 1.0)]));
            }
            if rand() < 0.3 {
                emit("devin", usage(8_000.0, 2_000.0, 0.0, Some(Cost { amount: 2.0, currency: "devin-credit".into(), kind: CostType::Credits }), &[]));
            }
        }
    }
    core.hooks().emit::<AgentUsageLimits>(AgentUsageLimitsEvent {
        task_id: "task".into(),
        harness_id: "claude-code".into(),
        at: now,
        limits: UsageLimits {
            status: UsageLimitStatus::Ok,
            windows: vec![
                UsageLimitWindow { id: "five_hour".into(), utilization: 0.42, resets_at: Some((now + 2 * hour + 14 * 60_000) as f64), duration_ms: Some(5.0 * hour as f64) },
                UsageLimitWindow { id: "seven_day".into(), utilization: 0.78, resets_at: Some((now + 3 * 24 * hour + 5 * hour) as f64), duration_ms: Some(7.0 * 24.0 * hour as f64) },
            ],
            using_overage: Some(false),
        },
    });
}

fn main() {
    gpui_kit::application().with_assets(NotefigAssets).run(move |cx| {
        notefig_ui::init(cx);
        let dark = std::env::var("NOTEFIG_THEME").map(|v| v != "light").unwrap_or(true);
        notefig_ui::set_appearance(Some(dark), None, cx);
        let fake = FakePlatform::new();
        let core = Core::new(
            CreateCoreOptions::new(GpuiExecutor::new(cx))
                .services(Services::new().with::<PlatformService>(fake.platform.clone()))
                .modules(vec![ModuleRef::of::<HarnessAdaptersModule>(), ModuleRef::of::<UsageModule>()]),
        )
        .expect("core");
        core.boot();
        if std::env::var_os("NOTEFIG_USAGE_EMPTY").is_none() {
            seed(&core);
        }
        cx.set_global(CoreGlobal(core));
        let settled = cx.core().use_::<UsageModule>().settled();
        cx.spawn(async move |cx| {
            settled.await;
            cx.update(|cx| {
                let w: f32 = std::env::var("NOTEFIG_W").ok().and_then(|w| w.parse().ok()).unwrap_or(1100.);
                let bounds = Bounds::centered(None, size(px(w), px(1000.)), cx);
                let window = gpui_kit::open_window(
                    {
                        // `NOTEFIG_HEADLESS=1`: never shown or focused; `shot:` still renders.
                        let headless = std::env::var_os("NOTEFIG_HEADLESS").is_some();
                        WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), show: !headless, focus: !headless, ..Default::default() }
                    },
                    cx,
                    |window, cx| {
                        let section = cx.new(|cx| UsageSettings::new(window, cx));
                        cx.new(|_| Host { section })
                    },
                )
                .expect("window");
                notefig_ui::driver::run_from_env(window.0, cx);
            })
        })
        .detach();
        let _ = fake;
    });
}
