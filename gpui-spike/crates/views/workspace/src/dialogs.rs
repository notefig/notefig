//! The shell's dialogs: `close-workspace-dialog.tsx` (closing a workspace
//! with agent tasks mid-run asks first) and `text-prompt-dialog.tsx` (the
//! in-app single-line prompt behind `PlatformUi::prompt_text`).

use std::cell::RefCell;
use std::rc::Rc;

use futures::channel::oneshot;
use gpui::{App, AppContext as _, Focusable as _, Context, IntoElement, ParentElement, Render, Styled, Window, div};
use gpui_kit::component::WindowExt as _;
use gpui_kit::component::input::{Input, InputState};
use notefig_i18n::{t as tr, t_count_args};
use notefig_platform::TextPromptOptions;
use notefig_ui::{CoreExt as _, sp};

use crate::sidebar::project_name;

pub(crate) fn init(_: &mut App) {}

/// Ask for one line of text. Resolves `None` on cancel. Uses the active
/// window (or the first); call [`prompt_text_in`] from inside a window.
pub fn prompt_text(options: TextPromptOptions, cx: &mut App) -> oneshot::Receiver<Option<String>> {
    let (tx, rx) = oneshot::channel();
    let tx = Rc::new(RefCell::new(Some(tx)));
    let handle = cx.active_window().or_else(|| cx.windows().first().copied());
    if let Some(handle) = handle {
        let tx2 = tx.clone();
        let opened = handle.update(cx, move |_, window, cx| open_prompt(options, tx2, window, cx));
        if opened.is_err() {
            // Already inside this window's update: defer one turn.
            log::warn!("prompt_text: the window is busy; call prompt_text_in");
        }
    }
    rx
}

/// [`prompt_text`] in `window`.
pub fn prompt_text_in(options: TextPromptOptions, window: &mut Window, cx: &mut App) -> oneshot::Receiver<Option<String>> {
    let (tx, rx) = oneshot::channel();
    open_prompt(options, Rc::new(RefCell::new(Some(tx))), window, cx);
    rx
}

type Reply = Rc<RefCell<Option<oneshot::Sender<Option<String>>>>>;

fn open_prompt(options: TextPromptOptions, tx: Reply, window: &mut Window, cx: &mut App) {
    let input = cx.new(|cx| {
        let mut state = InputState::new(window, cx);
        if let Some(p) = &options.placeholder {
            state = state.placeholder(p.clone());
        }
        if let Some(v) = &options.default_value {
            state = state.default_value(v.clone());
        }
        state
    });
    let title = options.title.clone();
    let message = options.message.clone();
    let confirm = options.confirm_label.clone().unwrap_or_else(|| "OK".into());
    let focus = input.read(cx).focus_handle(cx);
    window.open_alert_dialog(cx, move |dialog, _, _| {
        let (ok_tx, cancel_tx) = (tx.clone(), tx.clone());
        let value = input.clone();
        let mut d = dialog
            .title(title.clone())
            .width(sp(105.))
            .show_cancel(true)
            .ok_text(confirm.clone())
            .on_ok(move |_, _, cx| {
                let v = value.read(cx).value().to_string();
                if let Some(tx) = ok_tx.borrow_mut().take() {
                    let _ = tx.send(Some(v));
                }
                true
            })
            .on_cancel(move |_, _, _| {
                if let Some(tx) = cancel_tx.borrow_mut().take() {
                    let _ = tx.send(None);
                }
                true
            });
        let body = div().py(sp(2.)).child(Input::new(&input));
        d = match &message {
            Some(m) => d.description(div().flex().flex_col().gap(sp(2.)).child(m.clone()).child(body)),
            None => d.description(body),
        };
        d
    });
    window.focus(&focus, cx);
}

/// Hook the shell keeps for the close confirmation.
pub struct CloseWorkspaceDialog;

impl CloseWorkspaceDialog {
    pub fn new(_: &mut Window, _: &mut Context<Self>) -> Self {
        Self
    }

    pub fn request(&mut self, path: &str, window: &mut Window, cx: &mut Context<Self>) {
        request_close_workspace(path, window, cx);
    }
}

impl Render for CloseWorkspaceDialog {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// `requestClose`: an idle workspace closes at once; one with agent tasks
/// mid-run asks first (closing demotes them to restorable sessions).
pub(crate) fn request_close_workspace(path: &str, window: &mut Window, cx: &mut App) {
    let running = crate::panels(cx).running_task_count.map(|f| f(path, cx)).unwrap_or(0);
    let close = {
        let path = path.to_string();
        move |cx: &mut App| {
            let fut = cx.core().workspace(&path).close();
            cx.foreground_executor().spawn(fut).detach();
        }
    };
    if running == 0 {
        close(cx);
        return;
    }
    let name = project_name(path);
    let close = Rc::new(close);
    window.open_alert_dialog(cx, move |dialog, _, _| {
        let close = close.clone();
        dialog
            .title(tr("closeWorkspaceTitle"))
            .description(t_count_args("closeWorkspaceBody", running as i64, &[("name", &name)]))
            .show_cancel(true)
            .cancel_text(tr("cancel"))
            .ok_text(tr("closeWorkspaceConfirm"))
            .on_ok(move |_, _, cx| {
                close(cx);
                true
            })
    });
}
