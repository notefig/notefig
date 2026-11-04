//! `DbSurface`: the app's persisted collections. The TS app persists TanStack
//! DB collections in SQLite; here a collection is a set of JSON documents by
//! key. A module loads its collection once (`load`) and writes through
//! (`put`/`delete`), keeping its own in-memory view.

use futures::FutureExt;
use futures::future::LocalBoxFuture;

pub trait Db {
    /// Every document in `collection`, in key order.
    fn load(&self, collection: &str) -> LocalBoxFuture<'static, anyhow::Result<Vec<(String, serde_json::Value)>>>;
    fn put(&self, collection: &str, key: &str, value: serde_json::Value) -> LocalBoxFuture<'static, anyhow::Result<()>>;
    fn delete(&self, collection: &str, key: &str) -> LocalBoxFuture<'static, anyhow::Result<()>>;
    fn clear(&self, collection: &str) -> LocalBoxFuture<'static, anyhow::Result<()>>;

    /// The documents of `collection` whose top-level numeric `field` lies in
    /// `[from, to)`, in key order — the TS on-demand collection's range read
    /// (usage loads one view's hours, not its whole history). The default
    /// loads the collection and filters; a db that can query (SQLite)
    /// overrides it.
    fn load_range(
        &self,
        collection: &str,
        field: &str,
        from: f64,
        to: f64,
    ) -> LocalBoxFuture<'static, anyhow::Result<Vec<(String, serde_json::Value)>>> {
        let field = field.to_string();
        self.load(collection)
            .map(move |rows| {
                Ok(rows?
                    .into_iter()
                    .filter(|(_, v)| v.get(&field).and_then(|n| n.as_f64()).is_some_and(|n| n >= from && n < to))
                    .collect())
            })
            .boxed_local()
    }
}
