//! The last session's URL (layout, sidebar, open dialogs) kept across
//! launches: a port of `modules/session/`. The URL carries the session;
//! this module restores it on a cold boot (a bare "/") and records it as
//! it changes, in a KV namespace of its own.
//!
//! The URL is the layout crate's [`UrlService`] (the TS `urlModule`).

use std::cell::Cell;
use std::rc::Rc;

use futures::FutureExt;
use notefig_core::{ExecutorExt, Module, ModuleContext, ModuleRef, Subscription};
use notefig_kv::{KvApi, KvModule};

const NAMESPACE: &str = "session";
const KEY: &str = "lastSearch";
/// Where the last search was kept before it had a namespace of its own.
const LEGACY_NAMESPACE: &str = "settings";

pub use notefig_layout::{UrlService, UrlState};

/// Restore once the saved search has loaded, then record the URL as it
/// stands and every change after. Recording starts only after the
/// restore, so the bare boot URL never overwrites the last session.
pub fn track_session(kv: Rc<KvApi>, url: Rc<dyn UrlState>, executor: Rc<dyn notefig_core::Executor>) -> Subscription {
    let stopped = Rc::new(Cell::new(false));
    let unsubscribe: Rc<std::cell::RefCell<Option<Subscription>>> = Rc::default();
    let record = {
        let kv = kv.clone();
        let url = url.clone();
        let executor = executor.clone();
        move || {
            if url.pathname() != "/" {
                return;
            }
            let search = url.search();
            // One encoding of "nothing": an empty search is stored as null.
            let value = if search.is_empty() { None } else { Some(search) };
            executor.spawn_local(kv.write(NAMESPACE, KEY, &value).map(|_| ()));
        }
    };
    let s = stopped.clone();
    let u = unsubscribe.clone();
    executor.spawn_local(async move {
        let saved = match kv.read::<Option<String>>(NAMESPACE, KEY).await {
            Some(saved) => saved,
            None => kv.read::<Option<String>>(LEGACY_NAMESPACE, KEY).await.flatten(),
        };
        if s.get() {
            return;
        }
        if url.pathname() == "/" && url.search().is_empty()
            && let Some(saved) = saved.filter(|s| !s.is_empty())
        {
            url.set_search(&saved, true);
        }
        record();
        *u.borrow_mut() = Some(url.subscribe(Box::new(record)));
    });
    Subscription::new(move || {
        stopped.set(true);
        unsubscribe.borrow_mut().take();
    })
}

/// `sessionModule`.
pub struct SessionModule;

impl Module for SessionModule {
    const NAME: &'static str = "session";
    type Api = ();
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<KvModule>(), ModuleRef::service::<UrlService>()]
    }

    fn register(_: &ModuleContext) {}

    fn boot(_: &Rc<()>, ctx: &ModuleContext) -> Option<Subscription> {
        Some(track_session(ctx.use_::<KvModule>(), ctx.service::<UrlService>(), ctx.executor()))
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use notefig_core::Listeners;
    use notefig_core::testing::TestExecutor;
    use notefig_kv::create_kv;
    use notefig_platform::fake::FakePlatform;

    use super::*;

    struct FakeUrl {
        path: RefCell<String>,
        search: RefCell<String>,
        listeners: Listeners<()>,
    }
    impl UrlState for FakeUrl {
        fn pathname(&self) -> String {
            self.path.borrow().clone()
        }
        fn search(&self) -> String {
            self.search.borrow().clone()
        }
        fn set_search(&self, s: &str, _: bool) {
            *self.search.borrow_mut() = s.into();
            self.listeners.emit();
        }
        fn subscribe(&self, l: Box<dyn Fn()>) -> Subscription {
            self.listeners.subscribe(move |_| l())
        }
    }

    fn url(search: &str) -> Rc<FakeUrl> {
        Rc::new(FakeUrl { path: RefCell::new("/".into()), search: RefCell::new(search.into()), listeners: Listeners::new() })
    }

    fn saved(exec: &TestExecutor, kv: &KvApi, ns: &str) -> Option<Option<String>> {
        exec.block_on(kv.read::<Option<String>>(ns, KEY))
    }

    #[test]
    fn restores_the_last_search_on_a_bare_boot_and_falls_back_to_settings() {
        let exec = TestExecutor::new();
        let fake = FakePlatform::new();
        let kv = Rc::new(create_kv(fake.db.clone()));
        exec.block_on(kv.write(LEGACY_NAMESPACE, KEY, &Some("?legacy=1"))).unwrap();
        let u = url("");
        let _s = track_session(kv.clone(), u.clone(), exec.clone());
        exec.run_until_parked();
        assert_eq!(u.search(), "?legacy=1");
        exec.block_on(kv.write(NAMESPACE, KEY, &Some("?a=1"))).unwrap();
        let u = url("");
        let _s = track_session(kv.clone(), u.clone(), exec.clone());
        exec.run_until_parked();
        assert_eq!(u.search(), "?a=1");
    }

    #[test]
    fn leaves_a_url_naming_a_session_alone_saves_it_and_records_changes_never_into_settings() {
        let exec = TestExecutor::new();
        let fake = FakePlatform::new();
        let kv = Rc::new(create_kv(fake.db.clone()));
        exec.block_on(kv.write(NAMESPACE, KEY, &Some("?old"))).unwrap();
        let u = url("?mine");
        let _s = track_session(kv.clone(), u.clone(), exec.clone());
        exec.run_until_parked();
        assert_eq!(u.search(), "?mine");
        assert_eq!(saved(&exec, &kv, NAMESPACE), Some(Some("?mine".into())));
        u.set_search("?next", false);
        exec.run_until_parked();
        assert_eq!(saved(&exec, &kv, NAMESPACE), Some(Some("?next".into())));
        assert_eq!(saved(&exec, &kv, LEGACY_NAMESPACE), None);
    }
}
