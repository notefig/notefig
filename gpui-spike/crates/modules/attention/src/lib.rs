//! Attention: what the app points the user at, derived. A port of
//! `utils/attention.ts` ([`derive_attention`]) and `hooks/use-attention.ts`
//! ([`AttentionModule`]: the live join of the agent store, prompt rounds,
//! the open workspaces and the `seen` ledger).
//!
//! Readers: the sessions panel (row glyphs, its title dot), the Everything
//! view, the workspace rail's badge (`by_workspace`) and the app-status
//! publisher (the menu's "needs attention" section and dot). Each reads
//! [`AttentionApi::get`] and re-renders on [`AttentionApi::subscribe`].

mod derive;

pub use derive::{
    Attention, AttentionAsk, AttentionItem, AttentionKind, AttentionRows, derive_attention, most_pressing,
};

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use notefig_agent::model::TurnStatus;
use notefig_agents::{AgentStore, AgentStoreModule};
use notefig_core::{Core, Listeners, Module, ModuleContext, ModuleRef, Subscription, WorkspaceLifecycle};
use notefig_prompt_rounds::{PromptRoundsApi, PromptRoundsModule};
use notefig_seen::{SeenApi, SeenModule};

/// `core.use_::<AttentionModule>()`: [`Attention`] now, recomputed when any
/// row it joins changes.
pub struct AttentionApi {
    inputs: Inputs,
    cache: RefCell<Option<Rc<Attention>>>,
    stale: Cell<bool>,
    changed: Listeners<()>,
}

struct Inputs {
    store: Rc<AgentStore>,
    rounds: Rc<PromptRoundsApi>,
    seen: Rc<SeenApi>,
    workspaces: WorkspaceLifecycle,
    key: Rc<dyn Fn(&str) -> String>,
}

impl AttentionApi {
    /// The attention model now (`useAttention()`).
    pub fn get(&self) -> Rc<Attention> {
        if self.stale.replace(false) || self.cache.borrow().is_none() {
            *self.cache.borrow_mut() = Some(Rc::new(self.compute()));
        }
        self.cache.borrow().clone().unwrap()
    }

    /// Called whenever attention may have changed (coalesce in the view).
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }

    fn compute(&self) -> Attention {
        let i = &self.inputs;
        let tasks = i.store.tasks();
        let mut running = Vec::new();
        let mut pending = Vec::new();
        for task in &tasks {
            for turn in i.store.turns(&task.task_id) {
                if turn.status == TurnStatus::Running {
                    running.push((turn.task_id.clone(), turn.turn_id.clone()));
                }
            }
            pending.extend(i.store.pending_permissions(&task.task_id));
        }
        let rounds = i.rounds.rounds();
        let open: HashSet<String> = i.workspaces.list().into_iter().map(|w| w.key).collect();
        let seen = i.seen.snapshot();
        derive_attention(&AttentionRows {
            tasks: &tasks,
            rounds: &rounds,
            running_turns: &running,
            open_workspace_keys: &open,
            pending_permissions: &pending,
            seen: &seen,
            workspace_key: &*i.key,
        })
    }

    fn invalidate(&self) {
        self.stale.set(true);
        self.changed.emit();
    }
}

/// `attentionModule`.
pub struct AttentionModule;

impl Module for AttentionModule {
    const NAME: &'static str = "attention";
    type Api = AttentionApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![
            ModuleRef::of::<AgentStoreModule>(),
            ModuleRef::of::<PromptRoundsModule>(),
            ModuleRef::of::<SeenModule>(),
        ]
    }

    fn register(ctx: &ModuleContext) -> AttentionApi {
        let handles = ctx.clone();
        AttentionApi {
            inputs: Inputs {
                store: ctx.use_::<AgentStoreModule>(),
                rounds: ctx.use_::<PromptRoundsModule>(),
                seen: ctx.use_::<SeenModule>(),
                workspaces: ctx.workspaces(),
                // Core's own key for a path, as the root configured it.
                key: Rc::new(move |path| handles.workspace_handle(path).key().to_string()),
            },
            cache: RefCell::default(),
            stale: Cell::new(true),
            changed: Listeners::new(),
        }
    }

    fn boot(api: &Rc<AttentionApi>, _: &ModuleContext) -> Option<Subscription> {
        let i = &api.inputs;
        let watch = |api: &Rc<AttentionApi>| {
            let weak = Rc::downgrade(api);
            move || {
                if let Some(api) = weak.upgrade() {
                    api.invalidate();
                }
            }
        };
        Some(Subscription::join(vec![
            i.store.subscribe(watch(api)),
            i.rounds.subscribe(watch(api)),
            i.seen.subscribe(watch(api)),
            i.workspaces.subscribe(watch(api)),
        ]))
    }
}

/// `useAttention()` for code holding core.
pub fn attention(core: &Core) -> Rc<Attention> {
    core.use_::<AttentionModule>().get()
}

#[cfg(test)]
mod tests;
