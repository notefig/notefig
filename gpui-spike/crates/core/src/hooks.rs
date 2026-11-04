//! The one event bus. A module declares the moments it announces as
//! [`Hook`] types next to its API (the Rust form of widening `CoreHookMap`),
//! emits them with [`Hooks::emit`], and others subscribe with [`Hooks::on`].

use std::any::{Any, TypeId};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use futures::future::LocalBoxFuture;

use crate::executor::Executor;
use crate::subscription::Subscription;

/// A named moment and its payload.
pub trait Hook: 'static {
    const NAME: &'static str;
    type Payload: 'static;
}

/// What a handler returns: done now, or a future to await.
pub enum HookResult {
    Done(anyhow::Result<()>),
    Pending(LocalBoxFuture<'static, anyhow::Result<()>>),
}

impl From<()> for HookResult {
    fn from(_: ()) -> Self {
        HookResult::Done(Ok(()))
    }
}

impl From<anyhow::Result<()>> for HookResult {
    fn from(r: anyhow::Result<()>) -> Self {
        HookResult::Done(r)
    }
}

impl From<LocalBoxFuture<'static, anyhow::Result<()>>> for HookResult {
    fn from(f: LocalBoxFuture<'static, anyhow::Result<()>>) -> Self {
        HookResult::Pending(f)
    }
}

type ErasedHandler = Rc<dyn Fn(&dyn Any) -> HookResult>;

pub type OnError = Rc<dyn Fn(&anyhow::Error, &str)>;

#[derive(Clone)]
pub struct Hooks {
    inner: Rc<HooksInner>,
}

struct HooksInner {
    next: RefCell<u64>,
    handlers: RefCell<HashMap<TypeId, Vec<(u64, ErasedHandler)>>>,
    executor: Rc<dyn Executor>,
    on_error: OnError,
}

impl Hooks {
    pub fn new(executor: Rc<dyn Executor>, on_error: OnError) -> Self {
        Self {
            inner: Rc::new(HooksInner {
                next: RefCell::new(0),
                handlers: RefCell::new(HashMap::new()),
                executor,
                on_error,
            }),
        }
    }

    /// Subscribe; dropping the subscription unsubscribes. Handlers run in
    /// subscription order. Return `()`, a `Result`, or a boxed future.
    pub fn on<H: Hook, R: Into<HookResult>>(
        &self,
        handler: impl Fn(&H::Payload) -> R + 'static,
    ) -> Subscription {
        let id = {
            let mut next = self.inner.next.borrow_mut();
            *next += 1;
            *next
        };
        let erased: ErasedHandler = Rc::new(move |payload: &dyn Any| {
            let payload = payload
                .downcast_ref::<H::Payload>()
                .expect("hook payload matches its Hook type");
            handler(payload).into()
        });
        self.inner
            .handlers
            .borrow_mut()
            .entry(TypeId::of::<H>())
            .or_default()
            .push((id, erased));
        let weak = Rc::downgrade(&self.inner);
        Subscription::new(move || {
            if let Some(inner) = weak.upgrade()
                && let Some(list) = inner.handlers.borrow_mut().get_mut(&TypeId::of::<H>())
            {
                list.retain(|(i, _)| *i != id);
            }
        })
    }

    fn list_for<H: Hook>(&self) -> Vec<ErasedHandler> {
        self.inner
            .handlers
            .borrow()
            .get(&TypeId::of::<H>())
            .map(|list| list.iter().map(|(_, h)| h.clone()).collect())
            .unwrap_or_default()
    }

    /// Fire and forget. A handler that fails is reported and the rest still
    /// run: one module's failure must not starve the others.
    pub fn emit<H: Hook>(&self, payload: H::Payload) {
        for handler in self.list_for::<H>() {
            match handler(&payload) {
                HookResult::Done(Ok(())) => {}
                HookResult::Done(Err(err)) => (self.inner.on_error)(&err, H::NAME),
                HookResult::Pending(fut) => {
                    let on_error = self.inner.on_error.clone();
                    self.inner.executor.spawn(Box::pin(async move {
                        if let Err(err) = fut.await {
                            on_error(&err, H::NAME);
                        }
                    }));
                }
            }
        }
    }

    /// Run every handler one after another, awaiting each. A failure is
    /// reported and the rest still run; the caller gets the failures back,
    /// for a step that must not go on past one.
    pub async fn emit_serial<H: Hook>(&self, payload: H::Payload) -> Vec<anyhow::Error> {
        let mut failures = Vec::new();
        for handler in self.list_for::<H>() {
            let result = match handler(&payload) {
                HookResult::Done(r) => r,
                HookResult::Pending(fut) => fut.await,
            };
            if let Err(err) = result {
                (self.inner.on_error)(&err, H::NAME);
                failures.push(err);
            }
        }
        failures
    }
}
