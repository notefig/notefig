//! How the kernel and modules run async work. Single-threaded like the JS
//! event loop: futures are `!Send` and run on the UI thread. The root hands
//! core one; the app's runs on GPUI's executors, tests use
//! [`crate::testing::TestExecutor`].

use std::time::Duration;

use futures::future::LocalBoxFuture;

pub trait Executor {
    /// Run a future on the main thread, detached.
    fn spawn(&self, future: LocalBoxFuture<'static, ()>);
    /// Resolves after `duration`.
    fn timer(&self, duration: Duration) -> LocalBoxFuture<'static, ()>;
    /// Run blocking work off the main thread (disk, parsing); resolves with
    /// its result on the main thread.
    fn run_blocking(
        &self,
        work: Box<dyn FnOnce() -> Box<dyn std::any::Any + Send> + Send>,
    ) -> LocalBoxFuture<'static, Box<dyn std::any::Any + Send>>;
}

/// Typed helpers over [`Executor`].
pub trait ExecutorExt: Executor {
    fn spawn_local(&self, future: impl std::future::Future<Output = ()> + 'static) {
        self.spawn(Box::pin(future));
    }

    fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> LocalBoxFuture<'static, T> {
        let fut = self.run_blocking(Box::new(move || Box::new(work()) as Box<dyn std::any::Any + Send>));
        Box::pin(async move {
            *fut.await
                .downcast::<T>()
                .expect("run_blocking returned the work's own value")
        })
    }
}

impl<E: Executor + ?Sized> ExecutorExt for E {}
