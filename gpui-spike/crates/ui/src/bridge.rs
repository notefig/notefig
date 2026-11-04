use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use gpui::{App, BackgroundExecutor, Context, ForegroundExecutor, Global};
use notefig_core::{Core, Executor, Subscription};

/// Core's executor on GPUI's: futures on the main thread, blocking work on
/// the background pool.
pub struct GpuiExecutor {
    foreground: ForegroundExecutor,
    background: BackgroundExecutor,
}

impl GpuiExecutor {
    pub fn new(cx: &App) -> Rc<Self> {
        Rc::new(Self {
            foreground: cx.foreground_executor().clone(),
            background: cx.background_executor().clone(),
        })
    }
}

impl Executor for GpuiExecutor {
    fn spawn(&self, future: LocalBoxFuture<'static, ()>) {
        self.foreground.spawn(future).detach();
    }

    fn timer(&self, duration: Duration) -> LocalBoxFuture<'static, ()> {
        self.background.timer(duration).boxed_local()
    }

    fn run_blocking(
        &self,
        work: Box<dyn FnOnce() -> Box<dyn std::any::Any + Send> + Send>,
    ) -> LocalBoxFuture<'static, Box<dyn std::any::Any + Send>> {
        self.background.spawn(async move { work() }).boxed_local()
    }
}

/// The app's core, as a GPUI global.
pub struct CoreGlobal(pub Core);

impl Global for CoreGlobal {}

pub trait CoreExt {
    /// `useCore()`.
    fn core(&self) -> Core;
}

impl CoreExt for App {
    fn core(&self) -> Core {
        self.global::<CoreGlobal>().0.clone()
    }
}

/// Re-render the view whenever `subscribe`'s listener fires — how a view
/// reads module state (the TS `useSyncExternalStore`). Notifications are
/// coalesced: many changes in one turn cause one re-render. Keep the
/// returned subscription in the view.
///
/// ```ignore
/// self._files = observe(cx, |notify| files.subscribe(move || notify()));
/// ```
pub fn observe<V: 'static>(
    cx: &mut Context<V>,
    subscribe: impl FnOnce(Rc<dyn Fn()>) -> Subscription,
) -> Subscription {
    let (tx, rx) = async_channel::bounded::<()>(1);
    let notify: Rc<dyn Fn()> = Rc::new(move || {
        let _ = tx.try_send(());
    });
    let sub = subscribe(notify);
    let task = cx.spawn(async move |this, cx| {
        while rx.recv().await.is_ok() {
            if this.update(cx, |_, cx| cx.notify()).is_err() {
                break;
            }
        }
    });
    Subscription::join(vec![sub, Subscription::new(move || drop(task))])
}
