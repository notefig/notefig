//! A typed, persisted collection over the db: the Rust form of the TS
//! `persistedCollectionOptions` collections (open workspaces, recent
//! documents, seen). Rows live in memory once hydrated and write through to
//! the db table named by the collection id. Writes wait for hydration: a
//! write before it would be lost under what loads.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_core::{Listeners, Subscription};
use notefig_platform::Db;
use serde::Serialize;
use serde::de::DeserializeOwned;

pub struct PersistedCollection<T> {
    inner: Rc<Inner<T>>,
}

impl<T> Clone for PersistedCollection<T> {
    fn clone(&self) -> Self {
        Self { inner: self.inner.clone() }
    }
}

struct Inner<T> {
    id: String,
    db: Rc<dyn Db>,
    rows: RefCell<BTreeMap<String, T>>,
    hydrated: RefCell<bool>,
    preload: RefCell<Option<Shared<LocalBoxFuture<'static, ()>>>>,
    changed: Listeners<()>,
}

impl<T: Clone + Serialize + DeserializeOwned + 'static> PersistedCollection<T> {
    pub fn new(id: &str, db: Rc<dyn Db>) -> Self {
        Self {
            inner: Rc::new(Inner {
                id: id.to_string(),
                db,
                rows: RefCell::default(),
                hydrated: RefCell::new(false),
                preload: RefCell::new(None),
                changed: Listeners::new(),
            }),
        }
    }

    /// Load once; later calls join the first.
    pub fn preload(&self) -> LocalBoxFuture<'static, ()> {
        if let Some(p) = self.inner.preload.borrow().clone() {
            return p.boxed_local();
        }
        let inner = self.inner.clone();
        let fut = async move {
            match inner.db.load(&inner.id).await {
                Ok(rows) => {
                    let mut map = inner.rows.borrow_mut();
                    for (k, v) in rows {
                        match serde_json::from_value::<T>(v) {
                            Ok(v) => {
                                map.entry(k).or_insert(v);
                            }
                            Err(err) => log::warn!("{}: dropping unreadable row {k}: {err}", inner.id),
                        }
                    }
                }
                Err(err) => log::error!("{}: loading failed: {err:#}", inner.id),
            }
            *inner.hydrated.borrow_mut() = true;
            inner.changed.emit();
        }
        .boxed_local()
        .shared();
        *self.inner.preload.borrow_mut() = Some(fut.clone());
        fut.boxed_local()
    }

    pub fn is_hydrated(&self) -> bool {
        *self.inner.hydrated.borrow()
    }

    pub fn get(&self, key: &str) -> Option<T> {
        self.inner.rows.borrow().get(key).cloned()
    }

    pub fn has(&self, key: &str) -> bool {
        self.inner.rows.borrow().contains_key(key)
    }

    /// Every row, in key order.
    pub fn values(&self) -> Vec<T> {
        self.inner.rows.borrow().values().cloned().collect()
    }

    pub fn entries(&self) -> Vec<(String, T)> {
        self.inner.rows.borrow().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// Called after hydration and every change.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.inner.changed.subscribe(move |_| listener())
    }

    /// Insert-or-update. Visible at once when hydrated (else once the
    /// load lands); the future resolves once the row is durable.
    pub fn upsert(&self, key: &str, value: T) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let this = self.clone();
        let key = key.to_string();
        let json = serde_json::to_value(&value);
        let apply = move |this: &Self, key: &str, value: T| {
            this.inner.rows.borrow_mut().insert(key.to_string(), value);
            this.inner.changed.emit();
        };
        let mut pending = Some(value);
        if self.is_hydrated() {
            apply(self, &key, pending.take().unwrap());
        }
        async move {
            let json = json?;
            if let Some(value) = pending {
                this.preload().await;
                apply(&this, &key, value);
            }
            this.inner.db.put(&this.inner.id, &key, json).await
        }
        .boxed_local()
    }

    /// Update a row in place if present.
    pub fn update(&self, key: &str, f: impl FnOnce(&mut T)) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let Some(mut row) = self.get(key) else {
            return futures::future::ready(Ok(())).boxed_local();
        };
        f(&mut row);
        self.upsert(key, row)
    }

    /// Remove rows. Gone from memory at once when hydrated; the future
    /// resolves once durable.
    pub fn delete(&self, keys: Vec<String>) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let remove = |this: &Self, keys: Vec<String>| -> Vec<String> {
            let removed: Vec<String> = {
                let mut rows = this.inner.rows.borrow_mut();
                keys.into_iter().filter(|k| rows.remove(k).is_some()).collect()
            };
            if !removed.is_empty() {
                this.inner.changed.emit();
            }
            removed
        };
        let this = self.clone();
        let early = if self.is_hydrated() { Some(remove(self, keys.clone())) } else { None };
        async move {
            let removed = match early {
                Some(r) => r,
                None => {
                    this.preload().await;
                    remove(&this, keys)
                }
            };
            for k in removed {
                this.inner.db.delete(&this.inner.id, &k).await?;
            }
            Ok(())
        }
        .boxed_local()
    }
}
