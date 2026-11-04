//! Tunnel views: a port of `components/tunnel/{pair-dialog,tunnel-status}.tsx`
//! and `hooks/use-tunnel-connection.ts` (the [`observe`] on the connection).
//!
//! - [`PairDialog`]: the "connect a machine" modal. An overlay entity the
//!   shell places over the window body (it draws nothing while closed),
//!   driven by `core.tunnel.dialog()`. Deviation: TS uses the shadcn
//!   `Dialog` portal; gpui-kit's `open_dialog` needs gpui-kit's own window
//!   root, so this is a self-drawn overlay like `views/updater`'s toasts.
//! - [`TunnelStatus`]: the status-bar pill. TS renders it only in the web
//!   build (`isWeb()`); [`TunnelStatus::new`] keeps that rule (nothing on
//!   the desktop), [`TunnelStatus::always`] shows it regardless.
//! - [`ConnectMachine`]: an action that opens the dialog, so pairing is
//!   reachable on the desktop too (the palette owner may list it).

use std::rc::Rc;
use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, App, AppContext as _, ClickEvent, ClipboardItem, Context, ElementId,
    Entity, FontWeight, Hsla, InteractiveElement, IntoElement, MouseButton, ParentElement, Render, SharedString,
    StatefulInteractiveElement, Styled, Transformation, Window, div, percentage, prelude::FluentBuilder as _,
};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use notefig_core::{ExecutorExt, Subscription};
use notefig_i18n::{t, t_args};
use notefig_tunnel::{TunnelApi, TunnelConnectionState, TunnelModule};
use notefig_ui::{CoreExt as _, icon, observe, rem, sp, tokens};

gpui_kit::actions!(
    tunnel,
    [
        /// Open the "connect a machine" dialog.
        ConnectMachine,
    ]
);

pub fn init(cx: &mut App) {
    cx.on_action(|_: &ConnectMachine, cx| tunnel(cx).dialog().open(None));
}

/// `useCore().tunnel`.
pub fn tunnel(cx: &App) -> Rc<TunnelApi> {
    cx.core().use_::<TunnelModule>()
}

/// The command a user runs on the machine to pair with.
pub const AGENT_COMMAND: &str = "npx notefig agent";

/// `Loader2 animate-spin`.
fn spinner(id: impl Into<ElementId>, size: gpui::Pixels, color: Hsla) -> AnyElement {
    icon("loader-circle")
        .size(size)
        .text_color(color)
        .with_animation(id, Animation::new(Duration::from_secs(1)).repeat(), |svg, delta| {
            svg.with_transformation(Transformation::rotate(percentage(delta)))
        })
        .into_any_element()
}

#[derive(Clone, Copy, PartialEq)]
enum Variant {
    Primary,
    Ghost,
}

type OnClick = Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// shadcn `Button` (`h-9 px-4 text-sm font-medium rounded-md`).
fn button(
    id: &'static str,
    variant: Variant,
    leading: Option<AnyElement>,
    label: impl Into<SharedString>,
    disabled: bool,
    on_click: OnClick,
    cx: &App,
) -> gpui::Stateful<gpui::Div> {
    let tk = tokens(cx);
    let (bg, fg, hover) = match variant {
        Variant::Primary => (tk.primary, tk.primary_foreground, tk.primary.opacity(0.9)),
        Variant::Ghost => (gpui::transparent_black(), tk.foreground, tk.accent),
    };
    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .gap(sp(2.))
        .h(sp(9.))
        .px(sp(4.))
        .rounded(tk.radius_md)
        .bg(bg)
        .text_color(fg)
        .text_size(tk.text_sm)
        .font_weight(FontWeight::MEDIUM)
        .when(disabled, |d| d.opacity(0.5))
        .when(!disabled, |d| d.cursor_pointer().hover(move |s| s.bg(hover)).on_click(on_click))
        .children(leading)
        .child(label.into())
}

/// The "connect a machine" modal (`PairDialog`).
pub struct PairDialog {
    tunnel: Rc<TunnelApi>,
    code: Entity<InputState>,
    submitting: bool,
    error: Option<String>,
    copied: bool,
    /// The deep-link code auto-connected during this open.
    auto_connected: Option<String>,
    was_open: bool,
    _subs: Vec<Subscription>,
    _input: gpui::Subscription,
}

impl PairDialog {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let tunnel = tunnel(cx);
        let code = cx.new(|cx| InputState::new(window, cx).placeholder(t("tunnelPairCodePlaceholder")));
        let input = cx.subscribe_in(&code, window, |this, _, event: &InputEvent, _, cx| match event {
            InputEvent::PressEnter { .. } => this.submit(cx),
            InputEvent::Change => cx.notify(),
            _ => {}
        });
        let (dialog, connection) = (tunnel.clone(), tunnel.clone());
        let subs = vec![
            observe(cx, move |notify| dialog.dialog().subscribe(move || notify())),
            observe(cx, move |notify| connection.connection().subscribe(move || notify())),
        ];
        Self {
            tunnel,
            code,
            submitting: false,
            error: None,
            copied: false,
            auto_connected: None,
            was_open: false,
            _subs: subs,
            _input: input,
        }
    }

    fn submit(&mut self, cx: &mut Context<Self>) {
        let code = self.code.read(cx).value().trim().to_string();
        if !code.is_empty() {
            self.connect(code, cx);
        }
    }

    fn connect(&mut self, code: String, cx: &mut Context<Self>) {
        self.submitting = true;
        self.error = None;
        cx.notify();
        let connecting = self.tunnel.connect(&code);
        cx.spawn(async move |this, cx| {
            let result = connecting.await;
            let _ = this.update(cx, |this, cx| {
                this.submitting = false;
                match result {
                    Ok(_) => this.tunnel.dialog().close(),
                    Err(error) => this.error = Some(error.message),
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn copy_command(&mut self, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(AGENT_COMMAND.to_string()));
        self.copied = true;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            let _ = this.update(cx, |this, cx| {
                this.copied = false;
                cx.notify();
            });
        })
        .detach();
    }

    /// Per-open bookkeeping: reset the form on close, auto-connect a
    /// deep-link code once per open.
    fn sync_open_state(&mut self, open: bool, prefill: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        if !open {
            if self.was_open {
                self.code.update(cx, |s, cx| s.set_value("", window, cx));
                self.error = None;
                self.auto_connected = None;
            }
            self.was_open = false;
            return;
        }
        if !self.was_open {
            self.was_open = true;
            self.code.update(cx, |s, cx| s.focus(window, cx));
        }
        if let Some(code) = prefill
            && self.auto_connected.as_ref() != Some(&code)
        {
            self.auto_connected = Some(code.clone());
            self.connect(code, cx);
        }
    }

    fn body(&self, state: &TunnelConnectionState, cx: &mut Context<Self>) -> AnyElement {
        let tk = tokens(cx);
        let connecting = self.submitting || matches!(state, TunnelConnectionState::Connecting);
        if let TunnelConnectionState::Connected { worker_info } = state {
            let tunnel = self.tunnel.clone();
            let close = self.tunnel.clone();
            return div()
                .flex()
                .flex_col()
                .gap(sp(3.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(sp(2.))
                        .rounded(tk.radius_md)
                        .border_1()
                        .border_color(tk.border)
                        .bg(tk.muted.opacity(0.4))
                        .px(sp(3.))
                        .py(sp(2.))
                        .text_size(tk.text_sm)
                        .child(icon("wifi").size(rem(1.)).text_color(tk.success))
                        .child(div().truncate().child(worker_info.workspace_path.clone())),
                )
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(sp(2.))
                        .child(button(
                            "tunnel-disconnect",
                            Variant::Ghost,
                            None,
                            t("tunnelPairDisconnect"),
                            false,
                            Box::new(move |_, _, cx| {
                                tunnel.disconnect();
                                let forgetting = tunnel.forget();
                                cx.foreground_executor()
                                    .spawn(async move {
                                        let _ = forgetting.await;
                                    })
                                    .detach();
                            }),
                            cx,
                        ))
                        .child(button(
                            "tunnel-done",
                            Variant::Primary,
                            None,
                            t("tunnelPairDone"),
                            false,
                            Box::new(move |_, _, _| close.dialog().close()),
                            cx,
                        )),
                )
                .into_any_element();
        }
        if connecting {
            return div()
                .flex()
                .items_center()
                .justify_center()
                .gap(sp(2.))
                .py(sp(4.))
                .text_size(tk.text_sm)
                .text_color(tk.muted_foreground)
                .child(spinner("tunnel-connecting", rem(1.), tk.muted_foreground))
                .child(t("tunnelPairConnecting"))
                .into_any_element();
        }
        let empty = self.code.read(cx).value().trim().is_empty();
        div()
            .flex()
            .flex_col()
            .gap(sp(3.))
            .child(
                div()
                    .id("tunnel-copy-command")
                    .flex()
                    .items_center()
                    .justify_between()
                    .gap(sp(2.))
                    .w_full()
                    .rounded(tk.radius_md)
                    .border_1()
                    .border_color(tk.border)
                    .bg(tk.muted.opacity(0.4))
                    .hover(|s| s.bg(tk.muted))
                    .cursor_pointer()
                    .px(sp(3.))
                    .py(sp(2.))
                    .font_family("Menlo")
                    .text_size(tk.text_xs)
                    .tooltip(|window, cx| gpui_kit::component::tooltip::Tooltip::new(t("copy")).build(window, cx))
                    .on_click(cx.listener(|this, _, _, cx| this.copy_command(cx)))
                    .child(div().truncate().child(AGENT_COMMAND))
                    .child(if self.copied {
                        icon("check").size(sp(3.5)).text_color(tk.success)
                    } else {
                        icon("copy").size(sp(3.5)).text_color(tk.muted_foreground)
                    }),
            )
            .child(
                div()
                    .rounded(tk.radius_md)
                    .border_1()
                    .border_color(tk.border)
                    .bg(tk.background)
                    .px(sp(3.))
                    .py(sp(1.))
                    .child(Input::new(&self.code).appearance(false).text_size(tk.text_sm)),
            )
            .child(
                button(
                    "tunnel-connect",
                    Variant::Primary,
                    Some(icon("monitor-smartphone").size(rem(1.)).text_color(tk.primary_foreground).into_any_element()),
                    t("tunnelPairConnect"),
                    empty,
                    Box::new({
                        let this = cx.entity().downgrade();
                        move |_, _, cx| {
                            let _ = this.update(cx, |this, cx| this.submit(cx));
                        }
                    }),
                    cx,
                )
                .w_full(),
            )
            .when_some(self.error.clone(), |d, error| {
                d.child(div().text_size(tk.text_sm).text_color(tk.destructive).child(error))
            })
            .child(div().text_size(tk.text_xs).text_color(tk.muted_foreground).child(t("tunnelPairHint")))
            .into_any_element()
    }
}

impl Render for PairDialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dialog = self.tunnel.dialog().state();
        self.sync_open_state(dialog.open, dialog.prefill_code.clone(), window, cx);
        if !dialog.open {
            return div().into_any_element();
        }
        let tk = tokens(cx);
        let state = self.tunnel.connection().state();
        let (title, description) = match &state {
            TunnelConnectionState::Connected { worker_info } => {
                (t("tunnelPairedTitle"), t_args("tunnelPairedWith", &[("host", &worker_info.name)]))
            }
            _ => (t("tunnelPairTitle"), t("tunnelPairDescription")),
        };
        let close = self.tunnel.clone();
        let close_x = self.tunnel.clone();
        div()
            .id("pair-dialog-overlay")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .bg(gpui::black().opacity(0.5))
            .occlude()
            .on_mouse_down(MouseButton::Left, move |_, _, _| close.dialog().close())
            .on_key_down(cx.listener(|this, e: &gpui::KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" {
                    this.tunnel.dialog().close();
                    cx.stop_propagation();
                }
            }))
            .child(
                div()
                    .id("pair-dialog")
                    .relative()
                    .w(rem(24.))
                    .flex()
                    .flex_col()
                    .gap(sp(4.))
                    .p(sp(6.))
                    .rounded(tk.radius_lg)
                    .border_1()
                    .border_color(tk.border)
                    .bg(tk.background)
                    .text_color(tk.foreground)
                    .shadow_lg()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .id("pair-dialog-close")
                            .absolute()
                            .top(sp(4.))
                            .right(sp(4.))
                            .cursor_pointer()
                            .opacity(0.7)
                            .hover(|s| s.opacity(1.))
                            .on_click(move |_, _, _| close_x.dialog().close())
                            .child(icon("x").size(rem(1.)).text_color(tk.foreground)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(sp(1.5))
                            .child(
                                div()
                                    .text_size(rem(1.125))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(title),
                            )
                            .child(div().text_size(tk.text_sm).text_color(tk.muted_foreground).child(description)),
                    )
                    .child(self.body(&state, cx)),
            )
            .into_any_element()
    }
}

/// The status-bar pill (`TunnelStatus`). Every state opens the dialog.
pub struct TunnelStatus {
    tunnel: Rc<TunnelApi>,
    always: bool,
    _sub: Subscription,
}

impl TunnelStatus {
    /// As TS: nothing outside the web build.
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(false, cx)
    }

    /// Shown whatever the build.
    pub fn always(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        Self::build(true, cx)
    }

    fn build(always: bool, cx: &mut Context<Self>) -> Self {
        let tunnel = tunnel(cx);
        let observed = tunnel.clone();
        let sub = observe(cx, move |notify| observed.connection().subscribe(move || notify()));
        Self { tunnel, always, _sub: sub }
    }
}

impl Render for TunnelStatus {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.always && !self.tunnel.is_web() {
            return div().into_any_element();
        }
        let tk = tokens(cx);
        let row = |id: &'static str| {
            div()
                .id(id)
                .flex()
                .items_center()
                .justify_center()
                .gap(sp(2.))
                .text_size(tk.text_xs)
                .text_color(tk.muted_foreground)
        };
        let open = {
            let tunnel = self.tunnel.clone();
            move |_: &ClickEvent, _: &mut Window, _: &mut App| tunnel.dialog().open(None)
        };
        let fg = tk.foreground;
        match self.tunnel.connection().state() {
            TunnelConnectionState::Connected { worker_info } => row("tunnel-status")
                .cursor_pointer()
                .hover(move |s| s.text_color(fg))
                .on_click(open)
                .child(icon("wifi").size(sp(3.5)).text_color(tk.success))
                .child(t_args("tunnelStatusConnected", &[("host", &worker_info.name)]))
                .into_any_element(),
            TunnelConnectionState::Connecting => row("tunnel-status")
                .child(spinner("tunnel-status-spin", sp(3.5), tk.warning))
                .child(t("tunnelStatusConnecting"))
                .into_any_element(),
            TunnelConnectionState::Disconnected { error } => {
                // A failed or lost pairing offers "re-pair"; a fresh session a
                // subtle "connect a machine".
                let had_pairing = error.is_some();
                row("tunnel-status")
                    .cursor_pointer()
                    .hover(move |s| s.text_color(fg))
                    .on_click(open)
                    .child(if had_pairing {
                        icon("wifi-off").size(sp(3.5)).text_color(tk.destructive)
                    } else {
                        icon("monitor-smartphone").size(sp(3.5)).text_color(tk.muted_foreground)
                    })
                    .child(if had_pairing { t("tunnelStatusReconnect") } else { t("tunnelConnectMachine") })
                    .into_any_element()
            }
        }
    }
}

/// Spawn `future` on core's executor (for hosts that hold no context).
pub fn spawn_detached(cx: &App, future: impl std::future::Future<Output = ()> + 'static) {
    cx.core().executor().spawn_local(future);
}
