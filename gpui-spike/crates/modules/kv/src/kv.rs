use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, Shared};
use notefig_core::{Listeners, Subscription};
use notefig_platform::Db;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// One namespace: its rows in memory once hydrated, written through to the
/// db. Readers that render (`useKv`) read [`KvCollection::get`] and
/// subscribe; async callers await [`KvCollection::preload`] first.
#[derive(Clone)]
pub struct KvCollection {
    inner: Rc<CollectionInner>,
}

struct CollectionInner {
    /// The db's table name: `kv:<namespace>`, as the TS collection id.
    table: String,
    db: Rc<dyn Db>,
    rows: RefCell<BTreeMap<String, Value>>,
    hydrated: RefCell<bool>,
    preload: RefCell<Option<Shared<LocalBoxFuture<'static, ()>>>>,
    changed: Listeners<()>,
}

impl KvCollection {
    fn new(namespace: &str, db: Rc<dyn Db>) -> Self {
        Self {
            inner: Rc::new(CollectionInner {
                table: format!("kv:{namespace}"),
                db,
                rows: RefCell::default(),
                hydrated: RefCell::new(false),
                preload: RefCell::new(None),
                changed: Listeners::new(),
            }),
        }
    }

    /// Load the namespace once; later calls join the first.
    pub fn preload(&self) -> LocalBoxFuture<'static, ()> {
        if let Some(p) = self.inner.preload.borrow().clone() {
            return p.boxed_local();
        }
        let inner = self.inner.clone();
        let fut = async move {
            match inner.db.load(&inner.table).await {
                Ok(rows) => {
                    let mut map = inner.rows.borrow_mut();
                    for (k, v) in rows {
                        // A write that landed while we loaded wins.
                        map.entry(k).or_insert(v);
                    }
                }
                Err(err) => log::error!("kv: loading {} failed: {err:#}", inner.table),
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

    /// The value now, if hydrated and present.
    pub fn get(&self, key: &str) -> Option<Value> {
        self.inner.rows.borrow().get(key).cloned()
    }

    pub fn get_as<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        self.get(key).and_then(|v| serde_json::from_value(v).ok())
    }

    pub fn entries(&self) -> Vec<(String, Value)> {
        self.inner.rows.borrow().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// Called after hydration and after every write or removal.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.inner.changed.subscribe(move |_| listener())
    }

    /// Insert-or-update. Never before hydration: the write would be
    /// overwritten by what loads.
    fn upsert(&self, key: String, value: Value) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let this = self.clone();
        async move {
            this.preload().await;
            this.inner.rows.borrow_mut().insert(key.clone(), value.clone());
            this.inner.changed.emit();
            this.inner.db.put(&this.inner.table, &key, value).await
        }
        .boxed_local()
    }

    fn remove(&self, key: String) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let this = self.clone();
        async move {
            this.preload().await;
            if this.inner.rows.borrow_mut().remove(&key).is_none() {
                return Ok(());
            }
            this.inner.changed.emit();
            this.inner.db.delete(&this.inner.table, &key).await
        }
        .boxed_local()
    }
}

/// The KV store — `core.kv`. Reads wait for hydration; writes resolve once
/// the row is durable.
pub struct KvApi {
    db: Rc<dyn Db>,
    namespaces: RefCell<HashMap<String, KvCollection>>,
}

/// KV over the db it is handed; namespaces open lazily.
pub fn create_kv(db: Rc<dyn Db>) -> KvApi {
    KvApi {
        db,
        namespaces: RefCell::default(),
    }
}

impl KvApi {
    /// A namespace's collection, created on first use.
    pub fn collection(&self, namespace: &str) -> KvCollection {
        self.namespaces
            .borrow_mut()
            .entry(namespace.to_string())
            .or_insert_with(|| KvCollection::new(namespace, self.db.clone()))
            .clone()
    }

    pub fn read<T: DeserializeOwned + 'static>(&self, namespace: &str, key: &str) -> LocalBoxFuture<'static, Option<T>> {
        let rows = self.collection(namespace);
        let key = key.to_string();
        async move {
            rows.preload().await;
            rows.get_as(&key)
        }
        .boxed_local()
    }

    pub fn read_all<T: DeserializeOwned + 'static>(&self, namespace: &str) -> LocalBoxFuture<'static, BTreeMap<String, T>> {
        let rows = self.collection(namespace);
        async move {
            rows.preload().await;
            rows.entries()
                .into_iter()
                .filter_map(|(k, v)| serde_json::from_value(v).ok().map(|v| (k, v)))
                .collect()
        }
        .boxed_local()
    }

    pub fn write<T: Serialize>(&self, namespace: &str, key: &str, value: &T) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        match serde_json::to_value(value) {
            Ok(v) => self.collection(namespace).upsert(key.to_string(), v),
            Err(err) => futures::future::ready(Err(err.into())).boxed_local(),
        }
    }

    pub fn remove(&self, namespace: &str, key: &str) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        self.collection(namespace).remove(key.to_string())
    }
}
