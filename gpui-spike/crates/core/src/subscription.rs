//! RAII teardown: what `() => void` unsubscribes and disposers are in the TS
//! core. Dropping a [`Subscription`] runs it; `detach` keeps the thing alive.

use std::cell::RefCell;
use std::rc::{Rc, Weak};

/// Runs its closure once, on drop or [`Subscription::dispose`].
#[must_use = "dropping a Subscription unsubscribes; call .detach() to keep it"]
pub struct Subscription(Option<Box<dyn FnOnce()>>);

impl Subscription {
    pub fn new(f: impl FnOnce() + 'static) -> Self {
        Self(Some(Box::new(f)))
    }

    /// A subscription that does nothing.
    pub fn none() -> Self {
        Self(None)
    }

    /// Several, torn down in reverse order.
    pub fn join(mut subs: Vec<Subscription>) -> Self {
        Self::new(move || {
            while let Some(sub) = subs.pop() {
                drop(sub);
            }
        })
    }

    /// Never unsubscribe.
    pub fn detach(mut self) {
        self.0.take();
    }

    pub fn dispose(self) {
        drop(self);
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

type Listener<T> = Rc<dyn Fn(&T)>;

/// A list of listeners, what every observable module state keeps. Listeners
/// run in subscription order; one added or removed during a notify takes
/// effect from the next one.
pub struct Listeners<T: 'static = ()> {
    inner: Rc<RefCell<ListenersInner<T>>>,
}

struct ListenersInner<T> {
    next: u64,
    list: Vec<(u64, Listener<T>)>,
}

impl<T: 'static> Default for Listeners<T> {
    fn default() -> Self {
        Self {
            inner: Rc::new(RefCell::new(ListenersInner {
                next: 0,
                list: Vec::new(),
            })),
        }
    }
}

impl<T: 'static> Clone for Listeners<T> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl<T: 'static> Listeners<T> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn subscribe(&self, f: impl Fn(&T) + 'static) -> Subscription {
        let id = {
            let mut inner = self.inner.borrow_mut();
            inner.next += 1;
            let id = inner.next;
            inner.list.push((id, Rc::new(f)));
            id
        };
        let weak: Weak<RefCell<ListenersInner<T>>> = Rc::downgrade(&self.inner);
        Subscription::new(move || {
            if let Some(inner) = weak.upgrade() {
                inner.borrow_mut().list.retain(|(i, _)| *i != id);
            }
        })
    }

    pub fn notify(&self, value: &T) {
        let list: Vec<Listener<T>> = self.inner.borrow().list.iter().map(|(_, f)| f.clone()).collect();
        for f in list {
            f(value);
        }
    }

    pub fn len(&self) -> usize {
        self.inner.borrow().list.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Listeners<()> {
    pub fn emit(&self) {
        self.notify(&());
    }
}
