//! Seen: when the user last had each target in front of them. A port of
//! `modules/seen/`.
//!
//! Attention is a comparison, not a ledger: a thing needs attention when it
//! settled after the user last looked at where it lives. This module keeps
//! that one fact (one persisted timestamp per target) and the listener
//! that keeps it: a tab coming to the front of a focused window marks its
//! target seen, and a turn settling on the target already in front is
//! seen as it lands.
//!
//! Window focus: TS listens to `window` focus/blur. Here the shell tells
//! the ledger with [`SeenApi::set_window_focused`] (GPUI's window
//! activation), and the active tab with [`SeenApi::set_active_tab`].

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_agents::agent_events::{AgentTurnSettled, AgentTurnSettledEvent};
use notefig_core::{Executor, ExecutorExt, Module, ModuleContext, ModuleRef, Subscription};
use notefig_kv::PersistedCollection;
use notefig_prompt_rounds::PromptRoundsModule;
use notefig_platform::{Db, PlatformService};
use serde::{Deserialize, Serialize};

pub const SEEN_COLLECTION_ID: &str = "seen";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SeenTarget {
    Task(String),
    Document(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenRow {
    pub id: String,
    pub last_seen_at: i64,
}

pub fn seen_key(target: &SeenTarget) -> String {
    match target {
        SeenTarget::Task(id) => format!("task:{id}"),
        SeenTarget::Document(id) => format!("document:{id}"),
    }
}

/// What a tab is, as a target: the task for a chat tab (`agent:<id>`), the
/// document for a file tab (an absolute path), nothing for the rest.
pub fn target_of_tab(tab_id: Option<&str>) -> Option<SeenTarget> {
    let tab = tab_id?;
    if let Some(task) = tab.strip_prefix("agent:") {
        return Some(SeenTarget::Task(task.to_string()));
    }
    if tab == "release:" {
        return None;
    }
    Some(SeenTarget::Document(tab.to_string()))
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// `core.seen`.
pub struct SeenApi {
    collection: PersistedCollection<SeenRow>,
    /// A widget round's document, by turn id (prompt rounds).
    rounds: Rc<dyn Fn(&str) -> Option<String>>,
    executor: Rc<dyn Executor>,
    active: RefCell<Option<SeenTarget>>,
    window_focused: Cell<bool>,
}

pub fn create_seen(db: Rc<dyn Db>, rounds: Rc<dyn Fn(&str) -> Option<String>>, executor: Rc<dyn Executor>) -> SeenApi {
    SeenApi {
        collection: PersistedCollection::new(SEEN_COLLECTION_ID, db),
        rounds,
        executor,
        active: RefCell::default(),
        window_focused: Cell::new(true),
    }
}

impl SeenApi {
    pub fn collection(&self) -> &PersistedCollection<SeenRow> {
        &self.collection
    }

    /// `seenKey` → last seen, live (`useSeen`). Hydrates on first ask.
    pub fn snapshot(&self) -> HashMap<String, i64> {
        if !self.collection.is_hydrated() {
            self.executor.spawn_local(self.collection.preload());
        }
        self.collection.values().into_iter().map(|r| (r.id, r.last_seen_at)).collect()
    }

    pub fn last_seen_at(&self, target: &SeenTarget) -> i64 {
        self.collection.get(&seen_key(target)).map(|r| r.last_seen_at).unwrap_or(0)
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.collection.subscribe(listener)
    }

    /// Where a settled turn shows up: its widget's document for a widget
    /// round, else the session's chat tab.
    pub fn target_of_settled_turn(&self, task_id: &str, turn_id: &str) -> SeenTarget {
        match (self.rounds)(turn_id) {
            Some(doc) => SeenTarget::Document(doc),
            None => SeenTarget::Task(task_id.to_string()),
        }
    }

    /// Never moves a seen time backwards.
    pub fn mark_seen(&self, target: &SeenTarget, at: i64) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let collection = self.collection.clone();
        let id = seen_key(target);
        async move {
            collection.preload().await;
            let last = collection.get(&id).map(|r| r.last_seen_at).unwrap_or(i64::MIN);
            if last >= at {
                return Ok(());
            }
            collection.upsert(&id, SeenRow { id: id.clone(), last_seen_at: at }).await
        }
        .boxed_local()
    }

    fn mark_now(&self, target: SeenTarget) {
        let write = self.mark_seen(&target, now_ms());
        self.executor.spawn_local(async move {
            if let Err(err) = write.await {
                log::error!("Failed to mark seen: {err:#}");
            }
        });
    }

    /// The tab in front: seen now if the window is focused, else when the
    /// user comes back.
    pub fn set_active_tab(&self, tab_id: Option<&str>) {
        let target = target_of_tab(tab_id);
        *self.active.borrow_mut() = target.clone();
        if self.window_focused.get()
            && let Some(t) = target
        {
            self.mark_now(t);
        }
    }

    /// Window focus: coming back is looking again.
    pub fn set_window_focused(&self, focused: bool) {
        self.window_focused.set(focused);
        if focused && let Some(t) = self.active.borrow().clone() {
            self.mark_now(t);
        }
    }

    /// A turn settling on the target in front has been seen, at the turn's
    /// own settle time. In a background window it needs attention.
    pub fn record_settled_turn(&self, task_id: &str, turn_id: &str, at: i64) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let target = self.target_of_settled_turn(task_id, turn_id);
        let in_front = self.window_focused.get() && self.active.borrow().as_ref() == Some(&target);
        if in_front { self.mark_seen(&target, at) } else { futures::future::ready(Ok(())).boxed_local() }
    }

    /// The boot listener.
    pub fn track(self: &Rc<Self>, hooks: &notefig_core::Hooks) -> Subscription {
        let this = self.clone();
        let settled = hooks.on::<AgentTurnSettled, _>(move |e: &AgentTurnSettledEvent| {
            let write = this.record_settled_turn(&e.task_id, &e.turn_id, e.at);
            async move {
                write.await.map_err(|err| err.context("Failed to mark a settled turn seen"))
            }
            .boxed_local()
        });
        let this = self.clone();
        Subscription::join(vec![settled, Subscription::new(move || this.window_focused.set(true))])
    }
}

/// `seenModule`.
pub struct SeenModule;

impl Module for SeenModule {
    const NAME: &'static str = "seen";
    type Api = SeenApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>(), ModuleRef::of::<PromptRoundsModule>()]
    }

    /// A widget round's turn lands on its document (`rounds.get(turnId)`).
    fn register(ctx: &ModuleContext) -> SeenApi {
        let rounds = ctx.use_::<PromptRoundsModule>();
        create_seen(
            ctx.service::<PlatformService>().db.clone(),
            Rc::new(move |turn| rounds.round(turn).map(|r| r.document_path)),
            ctx.executor(),
        )
    }

    fn boot(api: &Rc<SeenApi>, ctx: &ModuleContext) -> Option<Subscription> {
        Some(api.track(ctx.hooks()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_core::Hooks;
    use notefig_core::testing::TestExecutor;
    use notefig_platform::fake::FakePlatform;

    fn setup() -> (Rc<TestExecutor>, Rc<SeenApi>) {
        let exec = TestExecutor::new();
        let fake = FakePlatform::new();
        let rounds: Rc<dyn Fn(&str) -> Option<String>> = Rc::new(|turn| (turn == "widget-turn").then(|| "/ws/doc.md".to_string()));
        (exec.clone(), Rc::new(create_seen(fake.db.clone(), rounds, exec)))
    }

    #[test]
    fn maps_tabs_to_targets() {
        assert_eq!(target_of_tab(Some("agent:task_1")), Some(SeenTarget::Task("task_1".into())));
        assert_eq!(target_of_tab(Some("/ws/a.md")), Some(SeenTarget::Document("/ws/a.md".into())));
        assert_eq!(target_of_tab(Some("release:")), None);
        assert_eq!(target_of_tab(None), None);
    }

    #[test]
    fn a_widget_round_lands_on_its_document_a_session_turn_on_its_task() {
        let (_e, seen) = setup();
        assert_eq!(seen.target_of_settled_turn("t", "widget-turn"), SeenTarget::Document("/ws/doc.md".into()));
        assert_eq!(seen.target_of_settled_turn("t", "other"), SeenTarget::Task("t".into()));
    }

    #[test]
    fn a_seen_time_never_moves_backwards() {
        let (exec, seen) = setup();
        let t = SeenTarget::Task("a".into());
        exec.block_on(seen.mark_seen(&t, 100)).unwrap();
        exec.block_on(seen.mark_seen(&t, 50)).unwrap();
        assert_eq!(seen.last_seen_at(&t), 100);
    }

    #[test]
    fn a_turn_settling_in_front_is_seen_elsewhere_or_in_background_it_is_not() {
        let (exec, seen) = setup();
        seen.set_active_tab(Some("agent:a"));
        exec.run_until_parked();
        exec.block_on(seen.record_settled_turn("b", "x", i64::MAX - 1)).unwrap();
        assert_eq!(seen.last_seen_at(&SeenTarget::Task("b".into())), 0);
        exec.block_on(seen.record_settled_turn("a", "x", i64::MAX - 1)).unwrap();
        assert_eq!(seen.last_seen_at(&SeenTarget::Task("a".into())), i64::MAX - 1);
        seen.set_window_focused(false);
        exec.run_until_parked();
        exec.block_on(seen.record_settled_turn("a", "y", i64::MAX)).unwrap();
        assert_eq!(seen.last_seen_at(&SeenTarget::Task("a".into())), i64::MAX - 1);
    }

    #[test]
    fn the_boot_listener_hears_settled_turns() {
        let (exec, seen) = setup();
        let hooks = Hooks::new(exec.clone(), Rc::new(|_, _| {}));
        let _sub = seen.track(&hooks);
        seen.set_active_tab(Some("agent:task_9"));
        exec.run_until_parked();
        hooks.emit::<AgentTurnSettled>(AgentTurnSettledEvent {
            task_id: "task_9".into(),
            turn_id: "t9".into(),
            status: notefig_agents::TurnStatus::Completed,
            at: i64::MAX,
        });
        exec.run_until_parked();
        assert_eq!(seen.last_seen_at(&SeenTarget::Task("task_9".into())), i64::MAX);
    }
}
