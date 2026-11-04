//! The agent tools' `history` service: the four `history_*` tools of
//! `modules/agents/tools/history-*.ts`, answered from the calling
//! workspace's [`WorkspaceHistory`].
//!
//! In TS the tools live in the agents module and reach the history through
//! `ctx.services.history`, a part of `ToolServices` the history module
//! declares. The agents crate keeps that seam as its `HistoryService`
//! trait, provided by the module that owns history: this one,
//! [`HistoryToolsModule`]. It is a module of its own, so a root without
//! agents (the git view's example, the CLI) lists `HistoryModule` alone.
//!
//! `history_restore` writes the checkpoint's content through the documents
//! module (`documents.write`), as the TS tool does: an open editor adopts it
//! as one undoable change.

use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_agent::services::AppToolCall;
use notefig_agents::{AgentsModule, HistoryService};
use notefig_core::{Module, ModuleContext, ModuleRef, Subscription};
use notefig_history::Signature;
use notefig_documents::DocumentsModule;
use serde_json::{Value, json};

use crate::{HistoryModule, WorkspaceHistory};

/// Provides the agents' `history` tool service.
pub struct HistoryToolsModule;

impl Module for HistoryToolsModule {
    const NAME: &'static str = "historyTools";
    type Api = ();
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![
            ModuleRef::of::<HistoryModule>(),
            ModuleRef::of::<AgentsModule>(),
            ModuleRef::of::<DocumentsModule>(),
        ]
    }

    fn register(_: &ModuleContext) {}

    fn boot(_: &Rc<()>, ctx: &ModuleContext) -> Option<Subscription> {
        let lookup = ctx.clone();
        ctx.use_::<AgentsModule>().tools.provide_history(Rc::new(HistoryTools {
            history: Rc::new(move |workspace_path| {
                lookup
                    .workspace_handle(workspace_path)
                    .get::<HistoryModule>()
                    .map_err(|_| format!("The history of '{workspace_path}' is not open"))
            }),
            write: {
                let documents = ctx.use_::<DocumentsModule>();
                Rc::new(move |path: &str, content: String| {
                    let fut = documents.write(path, &content);
                    async move { fut.await.map_err(|e| e.to_string()) }.boxed_local()
                })
            },
        }));
        None
    }
}

type Lookup = Rc<dyn Fn(&str) -> Result<Rc<WorkspaceHistory>, String>>;
/// An adopting write of a whole document (`documents.write`).
pub(crate) type Write = Rc<dyn Fn(&str, String) -> LocalBoxFuture<'static, Result<(), String>>>;

/// The service: each call goes to its workspace's open history.
pub(crate) struct HistoryTools {
    pub(crate) history: Lookup,
    pub(crate) write: Write,
}

/// Run one blocking tool body on the repo, flattening the two error layers.
fn run(
    history: &WorkspaceHistory,
    body: impl FnOnce(&dyn notefig_history::HistoryRepo) -> Result<Value, String> + Send + 'static,
) -> LocalBoxFuture<'static, Result<Value, String>> {
    let fut = history.run(move |repo| Ok(body(repo)));
    async move { fut.await.map_err(|e| e.message)? }.boxed_local()
}

impl HistoryService for HistoryTools {
    fn call(&self, workspace_path: &str, call: AppToolCall) -> LocalBoxFuture<'static, Result<Value, String>> {
        let history = match (self.history)(workspace_path) {
            Ok(history) => history,
            Err(err) => return futures::future::ready(Err(err)).boxed_local(),
        };
        match call {
            AppToolCall::HistoryLog { path } => {
                let relative = path.map(|(_, relative)| relative);
                run(&history, move |repo| notefig_history::tools::history_log(repo, relative.as_deref()))
            }
            AppToolCall::HistoryDiff { relative, from, to, .. } => {
                run(&history, move |repo| notefig_history::tools::history_diff(repo, &relative, &from, &to))
            }
            AppToolCall::HistoryCheckpoint { message } => {
                // Through the instance, so `git:stale` is announced.
                let commit = history.checkpoint(&message, Signature::agent_tool());
                async move {
                    let oid = commit.await.map_err(|e| e.message)?;
                    Ok(json!({ "oid": oid }))
                }
                .boxed_local()
            }
            AppToolCall::HistoryRestore { path, relative, checkpoint } => {
                let read = history.read(&checkpoint, &relative);
                let write = self.write.clone();
                async move {
                    let content = read.await.map_err(|e| e.message)?;
                    write(&path.to_string_lossy(), content).await?;
                    Ok(Value::Null)
                }
                .boxed_local()
            }
            other => futures::future::ready(Err(format!("{} is not a history tool", other.name()))).boxed_local(),
        }
    }
}
