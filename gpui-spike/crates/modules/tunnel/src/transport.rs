//! An agent transport over the tunnel — one per task, sharing the
//! connection (frames are tagged by task id). A port of
//! `tunnel-transport.ts`. The worker spawns the adapter on ctl
//! `start-task`; ACP lines ride "acp" frames both ways; stderr rides ctl
//! `task-diagnostic`; process death rides ctl `task-exit`.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::{Either, LocalBoxFuture};
use notefig_core::{Listeners, Subscription};

use crate::connection::{TransportError, TransportErrorKind, TunnelConnection};
use crate::protocol::CtlMessage;

pub const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelTransportSpec {
    pub task_id: String,
    /// The worker spawns the harness it knows by this id.
    pub harness_id: String,
    pub workspace_path: String,
    pub extra_env: BTreeMap<String, String>,
}

/// `TunnelTransport`. Clones share the transport.
#[derive(Clone)]
pub struct TunnelTransport {
    inner: Rc<Inner>,
}

struct Inner {
    spec: TunnelTransportSpec,
    connection: TunnelConnection,
    lines: RefCell<Listeners<String>>,
    close: RefCell<Listeners<Option<TransportError>>>,
    diagnostics: RefCell<Listeners<String>>,
    subscriptions: RefCell<Vec<Subscription>>,
    closed: Cell<bool>,
}

fn not_connected() -> TransportError {
    TransportError::new(
        TransportErrorKind::RelayUnreachable,
        "not connected to a worker — pair with a machine first",
    )
}

impl TunnelTransport {
    pub fn new(spec: TunnelTransportSpec, connection: TunnelConnection) -> Self {
        Self {
            inner: Rc::new(Inner {
                spec,
                connection,
                lines: RefCell::default(),
                close: RefCell::default(),
                diagnostics: RefCell::default(),
                subscriptions: RefCell::default(),
                closed: Cell::new(false),
            }),
        }
    }

    /// The agent runs on the worker: `"remote"` makes the ACP client
    /// advertise `fs: false`.
    pub fn locus(&self) -> &'static str {
        "remote"
    }

    /// ACP's cwd is the worker's real `--dir` (from pair-ack), not this
    /// app's workspace path.
    pub fn agent_cwd(&self) -> Option<String> {
        self.inner.connection.worker_info().map(|w| w.workspace_path)
    }

    pub fn start(&self) -> LocalBoxFuture<'static, Result<(), TransportError>> {
        let this = self.clone();
        async move {
            let inner = &this.inner;
            if !inner.connection.state().is_connected() {
                return Err(not_connected());
            }
            let task_id = inner.spec.task_id.clone();
            let weak = Rc::downgrade(inner);
            let for_acp = task_id.clone();
            let acp = inner.connection.on_acp({
                let weak = weak.clone();
                move |frame_task, line| {
                    if frame_task != for_acp {
                        return;
                    }
                    if let Some(inner) = weak.upgrade() {
                        let lines = inner.lines.borrow().clone();
                        lines.notify(&line.to_string());
                    }
                }
            });
            let for_ctl = task_id.clone();
            let ctl = inner.connection.on_ctl({
                let weak = weak.clone();
                move |message| {
                    if message.task_id() != Some(for_ctl.as_str()) {
                        return;
                    }
                    let Some(inner) = weak.upgrade() else { return };
                    match message {
                        CtlMessage::TaskDiagnostic { line, .. } => {
                            let diagnostics = inner.diagnostics.borrow().clone();
                            diagnostics.notify(line);
                        }
                        CtlMessage::TaskExit { code, .. } => {
                            // Code 0 is clean, anything else abnormal; a close
                            // we asked for stays silent.
                            let error = if inner.closed.get() || *code == Some(0) {
                                None
                            } else {
                                Some(TransportError::new(
                                    TransportErrorKind::Closed,
                                    match code {
                                        None => "agent process was killed".to_string(),
                                        Some(code) => format!("agent process exited (code {code})"),
                                    },
                                ))
                            };
                            Inner::fire_close(&inner, error);
                        }
                        _ => {}
                    }
                }
            });
            let closed = inner.connection.on_closed(move |error| {
                if let Some(inner) = weak.upgrade() {
                    Inner::fire_close(&inner, Some(error.clone()));
                }
            });
            inner.subscriptions.borrow_mut().extend([acp, ctl, closed]);

            let (tx, rx) = oneshot::channel::<Result<(), TransportError>>();
            let tx = RefCell::new(Some(tx));
            let for_start = task_id.clone();
            let started = inner.connection.on_ctl(move |message| {
                if message.task_id() != Some(for_start.as_str()) {
                    return;
                }
                let result = match message {
                    CtlMessage::TaskStarted { .. } => Ok(()),
                    CtlMessage::TaskSpawnError { message, .. } => {
                        Err(TransportError::new(TransportErrorKind::SpawnFailed, message.clone()))
                    }
                    _ => return,
                };
                if let Some(tx) = tx.borrow_mut().take() {
                    let _ = tx.send(result);
                }
            });
            inner.connection.send_ctl(&CtlMessage::StartTask {
                task_id,
                harness_id: inner.spec.harness_id.clone(),
                cwd: inner.spec.workspace_path.clone(),
                extra_env: inner.spec.extra_env.clone(),
            })?;
            let timeout = inner.connection.executor().timer(START_TIMEOUT);
            let result = match futures::future::select(rx, timeout).await {
                Either::Left((Ok(result), _)) => result,
                Either::Left((Err(_), _)) | Either::Right(_) => {
                    Err(TransportError::new(TransportErrorKind::SpawnFailed, "start-task timed out"))
                }
            };
            drop(started);
            result
        }
        .boxed_local()
    }

    pub fn send(&self, line: &str) {
        if self.inner.closed.get() {
            return;
        }
        // Connection gone mid-turn: on_closed surfaces it.
        let _ = self.inner.connection.send_acp(&self.inner.spec.task_id, line);
    }

    pub fn on_line(&self, callback: impl Fn(&str) + 'static) -> Subscription {
        self.inner.lines.borrow().subscribe(move |line| callback(line))
    }

    /// `None` is a clean close.
    pub fn on_close(&self, callback: impl Fn(Option<&TransportError>) + 'static) -> Subscription {
        self.inner.close.borrow().subscribe(move |error| callback(error.as_ref()))
    }

    pub fn on_diagnostic(&self, callback: impl Fn(&str) + 'static) -> Subscription {
        self.inner.diagnostics.borrow().subscribe(move |line| callback(line))
    }

    pub fn close(&self) {
        if self.inner.closed.replace(true) {
            return;
        }
        // Best effort: the worker kills everything on disconnect anyway.
        let _ = self
            .inner
            .connection
            .send_ctl(&CtlMessage::StopTask { task_id: self.inner.spec.task_id.clone() });
        self.inner.teardown();
    }
}

impl Inner {
    fn fire_close(this: &Rc<Self>, error: Option<TransportError>) {
        let listeners = this.close.borrow().clone();
        if listeners.is_empty() {
            return;
        }
        this.teardown();
        listeners.notify(&error);
    }

    fn teardown(&self) {
        let subs = std::mem::take(&mut *self.subscriptions.borrow_mut());
        drop(subs);
        *self.lines.borrow_mut() = Listeners::new();
        *self.close.borrow_mut() = Listeners::new();
        *self.diagnostics.borrow_mut() = Listeners::new();
    }
}
