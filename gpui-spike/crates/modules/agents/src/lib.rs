//! The agents module: a port of `packages/desktop/src/modules/agents/`.
//!
//! | TS | here |
//! |---|---|
//! | `agent-collections.ts`, `agent-persistence.ts` (`agentStoreModule`) | [`agent_store`] — [`AgentStoreModule`] |
//! | `agents.ts`, `workspace-agents.ts` (`agentsModule`) | [`agents`] — [`AgentsModule`] |
//! | `agent-service.ts` (`AgentTask`, `TaskManager`, `AgentRuntime`), `permission-broker.ts`, `harness-probe.ts`, `harnesses.ts`, `harness-discovery.ts` | `runtime` (private) |
//! | `agent-events.ts` | [`agent_events`] |
//! | `tools/*` + `ToolServices` | [`tools`] |
//! | `turn-usage.ts` | `notefig_agent::usage` (shared with the runtime) |
//! | `session-config.ts` | [`session_config`] |
//! | `mock-harness.ts`, `mock-mode.ts` | [`mock_harness`] (`NOTEFIG_AGENT_MOCK=1`) |
//!
//! The protocol and process layer under it is `notefig-agent`; harness
//! quirks are `notefig-harness-adapters`.
//!
//! Deviation: `harnesses` and `harnessProbe` are their own modules in TS;
//! here they live in the runtime (they share its thread and its state) and
//! are reached through [`AgentsApi`]'s harness methods.

pub mod agent_events;
pub mod agent_store;
pub mod agents;
pub mod mock_harness;
mod runtime;
pub mod session_config;
pub mod tools;

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::channel::oneshot;
use notefig_agent::services::ChannelServices;
use notefig_core::{ExecutorExt, Module, ModuleContext, ModuleRef, Subscription, WorkspacePart};
use notefig_harness_adapters::HarnessAdaptersModule;
use notefig_documents::DocumentsModule;
use notefig_kv::KvModule;
use notefig_tabs::TabsModule;
use notefig_platform::PlatformService;
use serde_json::Value;

pub use agent_store::{AgentStore, create_agent_store};
pub use agents::{ActionResult, AgentTaskHandle, AgentWorkspaceHandle, AgentsApi, PromptHandle, StartResult, StartedTask};
pub use notefig_agent::harness::{CustomHarnessEntry, HarnessDefinition, HarnessOverride, HarnessSettingsRow};
pub use notefig_agent::model::*;
pub use notefig_agent::prompt::{
    PromptCommand, PromptConfigChange, PromptContextPart, PromptExtras, WidgetPromptSource,
};
pub use notefig_agent::usage::{SessionUsage, TurnUsage, UsageLimits};
pub use tools::{DocumentsService, EditorsService, HistoryService, ToolServices};

/// The KV namespace for agent state (`AGENT_KV_NAMESPACE`): workspace
/// trust, signed-in marks, probe timestamps.
pub const AGENT_KV_NAMESPACE: &str = "agent";

/// The KV namespaces the runtime keeps state in (its keys are
/// `<namespace>/<key>`): trust and sign-in marks, catalog probe times.
const KV_NAMESPACES: &[&str] = &[AGENT_KV_NAMESPACE, "harness-probe"];

/// `agentStoreModule` — `core.agentStore`.
pub struct AgentStoreModule;

impl Module for AgentStoreModule {
    const NAME: &'static str = "agentStore";
    type Api = AgentStore;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>()]
    }

    fn register(ctx: &ModuleContext) -> AgentStore {
        create_agent_store(ctx.service::<PlatformService>().db.clone())
    }
}

/// `agentsModule` — `core.agents`, and `core.workspace(ws).agents`.
pub struct AgentsModule;

/// `core.agents`: the facade (derefs to [`AgentsApi`]), plus the tool
/// services other modules provide their part of.
pub struct AgentsModuleApi {
    pub agents: AgentsApi,
    pub tools: Rc<ToolServices>,
    ready: RefCell<Option<oneshot::Sender<()>>>,
}

impl std::ops::Deref for AgentsModuleApi {
    type Target = AgentsApi;
    fn deref(&self) -> &AgentsApi {
        &self.agents
    }
}

impl Module for AgentsModule {
    const NAME: &'static str = "agents";
    type Api = AgentsModuleApi;
    type Workspace = AgentWorkspaceHandle;

    fn needs() -> Vec<ModuleRef> {
        vec![
            ModuleRef::of::<AgentStoreModule>(),
            ModuleRef::of::<KvModule>(),
            ModuleRef::of::<HarnessAdaptersModule>(),
            ModuleRef::of::<DocumentsModule>(),
            ModuleRef::of::<TabsModule>(),
            ModuleRef::service::<PlatformService>(),
        ]
    }

    fn register(ctx: &ModuleContext) -> AgentsModuleApi {
        let store = ctx.use_::<AgentStoreModule>();
        let (tx, rx) = oneshot::channel::<()>();
        let ready = rx.map(|_| ()).boxed_local().shared();
        let tools = Rc::new(ToolServices::new(ctx.service::<PlatformService>().fs.clone()));
        // Agent reads and writes go through documents: a write adopts into
        // the open editor as one undoable change (TS `services.documents`).
        tools.provide_documents(Rc::new(tools::ShellDocuments(ctx.use_::<DocumentsModule>())));
        AgentsModuleApi {
            agents: AgentsApi::new(store, ctx.hooks().clone(), ready),
            tools,
            ready: RefCell::new(Some(tx)),
        }
    }

    fn boot(api: &Rc<AgentsModuleApi>, ctx: &ModuleContext) -> Option<Subscription> {
        if std::env::var_os("NOTEFIG_NO_AGENTS").is_some() {
            return None;
        }
        let platform = ctx.service::<PlatformService>();
        // `task(id).open()` → the task's chat tab (TS `deps.openAgentTab`).
        let tabs = ctx.use_::<TabsModule>();
        let open_tabs = ctx
            .hooks()
            .on::<agent_events::AgentOpenRequested, _>(move |e| tabs.open_agent(&e.task_id));
        let options = RuntimeOptions {
            probe_dir: platform.app_data_dir.join("harness-probe"),
            mock: mock_harness::is_mock_mode(),
            transport: None,
        };
        let runtime = start_runtime(api, ctx, options);
        Some(Subscription::join(vec![open_tabs, runtime.unwrap_or_else(Subscription::none)]))
    }

    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(
            WorkspacePart::new(|ctx, api: &Rc<AgentsModuleApi>| Ok(api.agents.workspace(&ctx.workspace().path)))
                .dispose(|_, ws, api: Rc<AgentsModuleApi>| api.agents.dispose_workspace(&ws.path).map(Ok).boxed_local()),
        )
    }
}

/// `ensureAgentRuntime`'s other half on the web: when the paired worker's
/// tunnel drops, every live task is gone with it, so dispose them all
/// (TS `tunnelModule` needs `workspaceAgentsModule` for this). A separate
/// module the web root lists, so desktop never pulls the tunnel in.
pub struct AgentsTunnelModule;

impl Module for AgentsTunnelModule {
    const NAME: &'static str = "agentsTunnel";
    type Api = ();
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<AgentsModule>(), ModuleRef::of::<notefig_tunnel::TunnelModule>()]
    }

    fn register(_: &ModuleContext) {}

    fn boot(_: &Rc<()>, ctx: &ModuleContext) -> Option<Subscription> {
        let agents = ctx.use_::<AgentsModule>();
        let tunnel = ctx.use_::<notefig_tunnel::TunnelModule>();
        Some(tunnel.connection().on_disconnect(move || agents.agents.dispose_all()))
    }
}

/// What a run varies about the runtime.
pub(crate) struct RuntimeOptions {
    pub probe_dir: std::path::PathBuf,
    /// `NOTEFIG_AGENT_MOCK=1`: the scripted mock harness serves every session.
    pub mock: bool,
    /// A transport in place of spawning (tests' fake agents).
    #[allow(dead_code)]
    pub transport: Option<std::sync::Arc<dyn notefig_agent::process::TransportFactory>>,
}

/// Hydrate the store, start the runtime thread, and pump its events,
/// snapshots and requests on core's executor.
pub(crate) fn start_runtime(
    api: &Rc<AgentsModuleApi>,
    ctx: &ModuleContext,
    options: RuntimeOptions,
) -> Option<Subscription> {
    let store = ctx.use_::<AgentStoreModule>();
    let kv = ctx.use_::<KvModule>();
    let hooks = ctx.hooks().clone();
    let executor = ctx.executor();
    let api2 = api.clone();
    let exec2 = executor.clone();
    let stopped = Rc::new(Cell::new(false));
    let stop_flag = stopped.clone();
    executor.spawn_local(async move {
        // Hydrate: the persisted collections plus the agent KV namespace.
        let mut persisted = store.load().await;
        for namespace in KV_NAMESPACES {
            for (key, value) in kv.read_all::<Value>(namespace).await {
                persisted.kv.insert(format!("{namespace}/{key}"), value);
            }
        }
        if stop_flag.get() {
            return;
        }
        let initial_kv = persisted.kv.clone();
        let (saves_tx, saves_rx) = async_channel::unbounded();
        let (services, requests) = ChannelServices::new();
        let mut config = runtime::host::HostConfig::new(
            runtime::store::ChannelStore {
                initial: persisted,
                saves: saves_tx,
            },
            services,
        );
        config.probe_dir = options.probe_dir;
        if options.mock {
            mock_harness::configure(&mut config);
        }
        if let Some(transport) = options.transport {
            config.transport = transport;
            config.discover_on_boot = false;
            config.probe_catalogs = false;
        }
        let (handle, events) = runtime::host::AgentHost::start(config);
        store.attach(handle.clone());
        api2.agents.attach(handle);
        if let Some(tx) = api2.ready.borrow_mut().take() {
            let _ = tx.send(());
        }
        // Row events → the store's readers, then core's hooks.
        let store2 = store.clone();
        exec2.spawn_local(async move {
            while let Ok(first) = events.recv().await {
                let mut batch = vec![first];
                while let Ok(more) = events.try_recv() {
                    batch.push(more);
                }
                store2.apply(&batch);
                for event in &batch {
                    if let runtime::events::AgentEvent::Diagnostic { task_id, label, detail } = event {
                        log::debug!("agent {task_id:?} {label}: {detail}");
                    }
                    agent_events::announce(&hooks, event);
                }
            }
        });
        // Durable snapshots → the db and the agent KV namespace.
        let store3 = store.clone();
        exec2.spawn_local(async move {
            let mut saved_kv: BTreeMap<String, Value> = initial_kv;
            while let Ok(mut snapshot) = saves_rx.recv().await {
                while let Ok(newer) = saves_rx.try_recv() {
                    snapshot = newer;
                }
                store3.persist(&snapshot).await;
                for (key, value) in &snapshot.kv {
                    if saved_kv.get(key) != Some(value)
                        && let Some((namespace, key)) = key.split_once('/')
                    {
                        let _ = kv.write(namespace, key, value).await;
                    }
                }
                let gone: Vec<String> = saved_kv.keys().filter(|k| !snapshot.kv.contains_key(*k)).cloned().collect();
                for key in gone {
                    if let Some((namespace, key)) = key.split_once('/') {
                        let _ = kv.remove(namespace, key).await;
                    }
                }
                saved_kv = snapshot.kv.clone();
            }
        });
        // What only the app can answer (fs, tools) → the tool services.
        let tools = api2.tools.clone();
        let exec3 = exec2.clone();
        exec2.spawn_local(async move {
            while let Ok(request) = requests.recv().await {
                exec3.spawn_local(tools.serve(request));
            }
        });
    });
    let api3 = api.clone();
    Some(Subscription::new(move || {
        stopped.set(true);
        // Core is going: stop every task, flush, kill every child.
        drop(api3.agents.dispose_all());
        notefig_agent::process::kill_all();
    }))
}

#[cfg(test)]
mod tests;
