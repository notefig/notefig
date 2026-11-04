//! A deterministic executor for module tests: futures run when the test
//! says so (`run_until_parked`), and timers fire when the test advances the
//! clock. Blocking work runs inline.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use futures::channel::oneshot;
use futures::executor::{LocalPool, LocalSpawner};
use futures::future::LocalBoxFuture;
use futures::task::LocalSpawnExt;
use futures::FutureExt;

use crate::executor::Executor;

pub struct TestExecutor {
    pool: RefCell<LocalPool>,
    spawner: LocalSpawner,
    now: RefCell<Duration>,
    timers: RefCell<Vec<(Duration, oneshot::Sender<()>)>>,
}

impl TestExecutor {
    pub fn new() -> Rc<Self> {
        let pool = LocalPool::new();
        let spawner = pool.spawner();
        Rc::new(Self {
            pool: RefCell::new(pool),
            spawner,
            now: RefCell::new(Duration::ZERO),
            timers: RefCell::new(Vec::new()),
        })
    }

    /// Run every task until none can make progress.
    pub fn run_until_parked(&self) {
        self.pool.borrow_mut().run_until_stalled();
    }

    /// Move the clock, firing due timers, and run until parked.
    pub fn advance(&self, by: Duration) {
        let target = *self.now.borrow() + by;
        loop {
            self.run_until_parked();
            let next = {
                let timers = self.timers.borrow();
                timers.iter().map(|(at, _)| *at).filter(|at| *at <= target).min()
            };
            let Some(at) = next else { break };
            *self.now.borrow_mut() = at;
            let due: Vec<_> = {
                let mut timers = self.timers.borrow_mut();
                let (due, rest): (Vec<_>, Vec<_>) = timers.drain(..).partition(|(t, _)| *t <= at);
                *timers = rest;
                due
            };
            for (_, tx) in due {
                let _ = tx.send(());
            }
        }
        *self.now.borrow_mut() = target;
        self.run_until_parked();
    }

    /// Drive `future` to completion, panicking if it parks unfinished.
    pub fn block_on<T: 'static>(&self, future: impl std::future::Future<Output = T> + 'static) -> T {
        let slot: Rc<RefCell<Option<T>>> = Rc::default();
        let out = slot.clone();
        self.spawner
            .spawn_local(async move {
                *out.borrow_mut() = Some(future.await);
            })
            .expect("spawn");
        self.run_until_parked();
        let value = slot.borrow_mut().take();
        value.expect("block_on: the future parked without finishing")
    }

    pub fn now(&self) -> Duration {
        *self.now.borrow()
    }
}

impl Executor for TestExecutor {
    fn spawn(&self, future: LocalBoxFuture<'static, ()>) {
        self.spawner.spawn_local(future).expect("spawn");
    }

    fn timer(&self, duration: Duration) -> LocalBoxFuture<'static, ()> {
        let (tx, rx) = oneshot::channel();
        let at = *self.now.borrow() + duration;
        self.timers.borrow_mut().push((at, tx));
        rx.map(|_| ()).boxed_local()
    }

    fn run_blocking(
        &self,
        work: Box<dyn FnOnce() -> Box<dyn std::any::Any + Send> + Send>,
    ) -> LocalBoxFuture<'static, Box<dyn std::any::Any + Send>> {
        let value = work();
        futures::future::ready(value).boxed_local()
    }
}
