//! First-run telemetry consent (`components/telemetry-consent-dialog.tsx`,
//! mounted by `modules/telemetry/react.tsx`'s `TelemetryBootstrap`). Not
//! dismissable: telemetry stays buffered until it is answered. In this
//! port telemetry is never available, so the module never owes consent and
//! the dialog never opens by itself; [`show_consent_dialog`] shows it on
//! demand (the debug panel's "Reset telemetry consent").

use gpui::{
    App, AppContext as _, Context, Entity, FontWeight, IntoElement, ParentElement, Render, Styled,
    Window, div,
};
use gpui_kit::component::WindowExt as _;
use notefig_i18n::t;
use notefig_telemetry::{TelemetryAnswer, TelemetryModule};
use notefig_ui::{CoreExt, observe, rem, sp, tokens};

use crate::widgets::{Button, ButtonVariant, switch};

pub struct ConsentForm {
    crash: bool,
    analytics: bool,
}

impl Render for ConsentForm {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tk = tokens(cx).clone();
        let entity = cx.entity();
        let row = |id: &'static str, label: &str, desc: &str, checked: bool, set: Box<dyn Fn(&mut ConsentForm, bool)>, cx: &App| {
            let e = entity.clone();
            div()
                .flex()
                .items_center()
                .justify_between()
                .gap(sp(4.))
                .child(
                    div()
                        .child(div().text_size(tk.text_sm).font_weight(FontWeight::MEDIUM).child(t(label)))
                        .child(div().text_size(tk.text_xs).text_color(tk.muted_foreground).child(t(desc))),
                )
                .child(switch(id, checked, false, move |v, _, cx| e.update(cx, |this, cx| { set(this, v); cx.notify() }), cx))
        };
        let (crash, analytics) = (self.crash, self.analytics);
        div()
            .flex()
            .flex_col()
            .gap(sp(4.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(sp(2.))
                    .child(div().text_size(rem(1.125)).font_weight(FontWeight::SEMIBOLD).child(t("telemetryConsentTitle")))
                    .child(div().text_size(tk.text_sm).text_color(tk.muted_foreground).child(t("telemetryConsentBody"))),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(sp(4.))
                    .py(sp(2.))
                    .child(row("consent-crash", "telemetryCrashLabel", "telemetryCrashDescription", crash, Box::new(|s, v| s.crash = v), cx))
                    .child(row("consent-analytics", "telemetryAnalyticsLabel", "telemetryAnalyticsDescription", analytics, Box::new(|s, v| s.analytics = v), cx)),
            )
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap(sp(2.))
                    .child(
                        div().w_full().flex().child(
                            Button::new("consent-continue", t("telemetryConsentContinue"))
                                .variant(ButtonVariant::Primary)
                                .on_click(move |_, window, cx| {
                                    let answer = TelemetryAnswer { crash_enabled: crash, analytics_enabled: analytics };
                                    if let Some(telemetry) = cx.core().try_use::<TelemetryModule>() {
                                        telemetry.answer(answer);
                                    }
                                    window.close_dialog(cx);
                                })
                                .render(cx),
                        ),
                    )
                    .child(div().text_size(tk.text_xs).text_color(tk.muted_foreground).text_center().child(t("telemetryConsentFootnote"))),
            )
    }
}

/// Show the consent dialog (both switches on, as in TS).
pub fn show_consent_dialog(window: &mut Window, cx: &mut App) {
    let form: Entity<ConsentForm> = cx.new(|_| ConsentForm { crash: true, analytics: true });
    window.open_dialog(cx, move |dialog, _, _| {
        dialog.w(rem(27.5)).p(sp(6.)).close_button(false).keyboard(false).overlay_closable(false).child(form.clone())
    });
}

/// `TelemetryBootstrap`: opens the consent dialog while consent is owed
/// and a workspace is open. The shell creates one per main window.
pub struct TelemetryBootstrap {
    shown: bool,
    _sub: Option<notefig_core::Subscription>,
}

impl TelemetryBootstrap {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let core = cx.core();
        let sub = core.try_use::<TelemetryModule>().map(|t| {
            let t2 = t.clone();
            observe(cx, move |notify| t2.subscribe(move || notify()))
        });
        let mut this = Self { shown: false, _sub: sub };
        this.check(window, cx);
        this
    }

    fn check(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let core = cx.core();
        let owed = core.try_use::<TelemetryModule>().is_some_and(|t| t.consent_owed());
        let inside = !core.workspaces().list().is_empty();
        if owed && inside && !self.shown {
            self.shown = true;
            show_consent_dialog(window, cx);
        }
    }
}

impl Render for TelemetryBootstrap {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.check(window, cx);
        div()
    }
}
