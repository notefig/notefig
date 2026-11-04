//! Which prompt round wrote the content an editor is adopting: a port of
//! `packages/desktop/src/modules/turn-writes/` — `core.turnWrites`.
//!
//! Agent writes reach an open editor two ways, and neither says who wrote:
//! an ACP `fs/write_text_file` (adopted inside the write, while the tool
//! call is still running) or a harness writing to disk itself (adopted when
//! the watcher catches up, usually after the tool call reported done). So
//! attribution is two current-state facts per document, fed by
//! `agent:tool-call`:
//!
//! - IN FLIGHT: a mutating tool call on the path that has not settled yet.
//!   It stays in flight until its settle has read the file back.
//! - WRITTEN: when a mutating call settles, the file's bytes are read and
//!   their hash recorded as that round's.
//!
//! A turn that settles with calls still open (`agent:turn-settled`)
//! finishes them the same way. Nothing here is persisted.

#[cfg(test)]
mod tests;

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::Path;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::{LocalBoxFuture, join_all};
use notefig_agent::model::ToolCallView;
use notefig_agent::paths::resolve_workspace_path;
use notefig_agents::agent_events::{AgentToolCall, AgentToolCallEvent, AgentTurnSettled};
use notefig_core::{Hooks, Module, ModuleContext, ModuleRef, Subscription};
use notefig_platform::{FileSystem, PlatformService, content_hash};
use notefig_prompt_widgets::{PromptChangeAttribution, PromptWidgetsApi, PromptWidgetsModule};

#[derive(Debug, Clone, PartialEq, Eq)]
struct Writer {
    task_id: String,
    turn_id: String,
}

#[derive(Debug, Clone)]
struct InFlightCall {
    writer: Writer,
    /// `task:toolCallId`.
    key: String,
    paths: Vec<String>,
}

/// Absolute paths the call names (a diff item may carry a relative one).
fn tool_call_paths(call: &ToolCallView, workspace_path: &str) -> Vec<String> {
    let mut named: Vec<String> = call.locations.clone();
    for item in &call.content {
        if let notefig_agent::model::ToolCallContentView::Diff { path, .. } = item {
            named.push(path.clone());
        }
    }
    let mut out: Vec<String> = Vec::new();
    for path in named {
        let abs = match resolve_workspace_path(Path::new(workspace_path), &path) {
            Ok((abs, _)) => abs.to_string_lossy().into_owned(),
            Err(_) => path,
        };
        if !out.contains(&abs) {
            out.push(abs);
        }
    }
    out
}

/// What `createTurnWrites` is handed.
pub struct TurnWritesDeps {
    pub fs: Rc<dyn FileSystem>,
    /// Where tool calls and settled turns are announced.
    pub hooks: Hooks,
    /// Which widget watches a round (`core.promptWidgets`).
    pub prompts: PromptWidgetsApi,
}

struct Inner {
    deps: TurnWritesDeps,
    /// path → the unsettled mutating calls on it, in first-seen order.
    in_flight: RefCell<HashMap<String, Vec<InFlightCall>>>,
    /// path → the round whose write the file held when its call settled.
    written: RefCell<HashMap<String, (Writer, String)>>,
}

/// `TurnWritesApi` — `core.turnWrites`.
#[derive(Clone)]
pub struct TurnWritesApi {
    inner: Rc<Inner>,
}

/// `createTurnWrites(deps)`.
pub fn create_turn_writes(deps: TurnWritesDeps) -> TurnWritesApi {
    TurnWritesApi {
        inner: Rc::new(Inner { deps, in_flight: RefCell::default(), written: RefCell::default() }),
    }
}

impl Inner {
    /// Record what the call left on disk, then let it leave flight.
    fn settle_call(self: &Rc<Self>, call: InFlightCall) -> LocalBoxFuture<'static, ()> {
        let this = self.clone();
        async move {
            let reads = call.paths.iter().map(|path| {
                let read = this.deps.fs.read_files(vec![path.clone()]);
                async move { read.await.succeeded.into_iter().next().map(|(_, content)| content_hash(&content)) }
            });
            let hashes = join_all(reads).await;
            for (path, hash) in call.paths.iter().zip(hashes) {
                if let Some(hash) = hash {
                    this.written.borrow_mut().insert(path.clone(), (call.writer.clone(), hash));
                }
            }
            let mut in_flight = this.in_flight.borrow_mut();
            for path in &call.paths {
                if let Some(calls) = in_flight.get_mut(path) {
                    calls.retain(|c| c.key != call.key);
                    if calls.is_empty() {
                        in_flight.remove(path);
                    }
                }
            }
        }
        .boxed_local()
    }

    /// The exact bytes a settled call left win; failing that, the latest
    /// call still mid-write on the path.
    fn writer_of(&self, path: &str, content_hash: &str) -> Option<Writer> {
        if let Some((writer, hash)) = self.written.borrow().get(path)
            && hash == content_hash
        {
            return Some(writer.clone());
        }
        self.in_flight.borrow().get(path)?.last().map(|c| c.writer.clone())
    }
}

impl TurnWritesApi {
    /// The `agent:tool-call` listener; resolves once a settling call's
    /// read-back is recorded.
    pub fn record_tool_call(&self, detail: &AgentToolCallEvent) -> LocalBoxFuture<'static, ()> {
        let done = futures::future::ready(()).boxed_local();
        let call = ToolCallView::from_value(&detail.tool_call);
        if !call.is_mutating() {
            return done;
        }
        let paths = tool_call_paths(&call, &detail.workspace_path);
        if paths.is_empty() {
            return done;
        }
        let entry = InFlightCall {
            writer: Writer { task_id: detail.task_id.clone(), turn_id: detail.turn_id.clone() },
            key: format!("{}:{}", detail.task_id, call.tool_call_id),
            paths: paths.clone(),
        };
        for path in &paths {
            // A new write supersedes whatever the last one left.
            self.inner.written.borrow_mut().remove(path);
            let mut in_flight = self.inner.in_flight.borrow_mut();
            let calls = in_flight.entry(path.clone()).or_default();
            match calls.iter_mut().find(|c| c.key == entry.key) {
                Some(existing) => *existing = entry.clone(),
                None => calls.push(entry.clone()),
            }
        }
        if matches!(call.status.as_deref(), Some("completed" | "failed")) {
            return self.inner.settle_call(entry);
        }
        done
    }

    /// The `agent:turn-settled` listener: close whatever the turn left open.
    pub fn record_turn_settled(&self, turn_id: &str) -> LocalBoxFuture<'static, ()> {
        let mut open: Vec<InFlightCall> = Vec::new();
        for calls in self.inner.in_flight.borrow().values() {
            for call in calls {
                if call.writer.turn_id == turn_id && !open.iter().any(|c| c.key == call.key) {
                    open.push(call.clone());
                }
            }
        }
        let settles: Vec<_> = open.into_iter().map(|c| self.inner.settle_call(c)).collect();
        async move {
            join_all(settles).await;
        }
        .boxed_local()
    }

    /// The round to credit with adopting `content_hash` into the editor for
    /// `path`: `None` when no round wrote it, or the round that did is no
    /// longer the one its widget watches. Reads current state only.
    pub fn attribute(&self, path: &str, content_hash: &str) -> Option<PromptChangeAttribution> {
        let writer = self.inner.writer_of(path, content_hash)?;
        let widget = self.inner.deps.prompts.find_by_task(&writer.task_id, Some(&writer.turn_id))?;
        Some(PromptChangeAttribution { blob_id: widget.blob_id, turn_id: writer.turn_id })
    }

    /// Boot: the one listener pair.
    pub fn track(&self) -> Subscription {
        let hooks = &self.inner.deps.hooks;
        let (a, b) = (self.clone(), self.clone());
        Subscription::join(vec![
            hooks.on::<AgentToolCall, _>(move |detail| a.record_tool_call(detail).map(Ok::<(), anyhow::Error>).boxed_local()),
            hooks.on::<AgentTurnSettled, _>(move |detail| b.record_turn_settled(&detail.turn_id).map(Ok::<(), anyhow::Error>).boxed_local()),
        ])
    }
}

/// `turnWritesModule`: attributes agent writes to the turn that made them.
pub struct TurnWritesModule;

impl Module for TurnWritesModule {
    const NAME: &'static str = "turnWrites";
    type Api = TurnWritesApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>(), ModuleRef::of::<PromptWidgetsModule>()]
    }

    fn register(ctx: &ModuleContext) -> TurnWritesApi {
        create_turn_writes(TurnWritesDeps {
            fs: ctx.service::<PlatformService>().fs.clone(),
            hooks: ctx.hooks().clone(),
            prompts: ctx.use_::<PromptWidgetsModule>().widgets.clone(),
        })
    }

    fn boot(api: &Rc<TurnWritesApi>, _ctx: &ModuleContext) -> Option<Subscription> {
        Some(api.track())
    }
}
