//! The app's MCP endpoint over the tunnel — this side of the MCP
//! inversion. A port of `tunnel-mcp-endpoint.ts`. The worker binds a
//! loopback listener per task (ctl `mcp-open` → `mcp-opened`) and the
//! harness spawns the CLI's `mcp-relay` against it; request lines arrive
//! as "mcp" frames tagged {taskId, connId}, and each request's `respond`
//! closes over its connId.

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::{Either, LocalBoxFuture};
use notefig_core::{Listeners, Subscription};

use crate::connection::{TransportError, TransportErrorKind, TunnelConnection};
use crate::protocol::{CtlMessage, McpServerSpec};

pub const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// Answers one request line, on the relay connection it came from.
pub type McpRespond = Rc<dyn Fn(&str)>;

#[derive(Clone)]
pub struct TunnelMcpEndpoint {
    inner: Rc<Inner>,
}

struct Inner {
    task_id: String,
    connection: TunnelConnection,
    requests: RefCell<Listeners<(String, McpRespond)>>,
    subscriptions: RefCell<Vec<Subscription>>,
    closed: Cell<bool>,
    mcp_server: RefCell<Option<McpServerSpec>>,
}

impl TunnelMcpEndpoint {
    pub fn new(task_id: impl Into<String>, connection: TunnelConnection) -> Self {
        Self {
            inner: Rc::new(Inner {
                task_id: task_id.into(),
                connection,
                requests: RefCell::default(),
                subscriptions: RefCell::default(),
                closed: Cell::new(false),
                mcp_server: RefCell::default(),
            }),
        }
    }

    /// The stdio spec the harness should spawn — worker-machine paths,
    /// meaningful exactly where the harness runs. Set once `start` resolves.
    pub fn mcp_server(&self) -> Option<McpServerSpec> {
        self.inner.mcp_server.borrow().clone()
    }

    pub fn start(&self) -> LocalBoxFuture<'static, Result<(), TransportError>> {
        let this = self.clone();
        async move {
            let inner = &this.inner;
            if !inner.connection.state().is_connected() {
                return Err(TransportError::new(
                    TransportErrorKind::RelayUnreachable,
                    "not connected to a worker — pair with a machine first",
                ));
            }
            // Subscribe before opening so no early request line is missed.
            let weak = Rc::downgrade(inner);
            let mcp = inner.connection.on_mcp(move |task, conn_id, line| {
                let Some(inner) = weak.upgrade() else { return };
                if task != inner.task_id {
                    return;
                }
                let weak = Rc::downgrade(&inner);
                let respond: McpRespond = Rc::new(move |reply: &str| {
                    let Some(inner) = weak.upgrade() else { return };
                    if inner.closed.get() {
                        return;
                    }
                    if let Err(error) = inner.connection.send_mcp(&inner.task_id, conn_id, reply) {
                        // Routine churn: that relay connection (or the tunnel) is gone.
                        log::warn!("[mcp {}] reply to connection {conn_id} failed: {error}", inner.task_id);
                    }
                });
                let requests = inner.requests.borrow().clone();
                requests.notify(&(line.to_string(), respond));
            });
            inner.subscriptions.borrow_mut().push(mcp);

            let (tx, rx) = oneshot::channel::<McpServerSpec>();
            let tx = RefCell::new(Some(tx));
            let task_id = inner.task_id.clone();
            let opened = inner.connection.on_ctl(move |message| {
                if let CtlMessage::McpOpened { task_id: t, mcp_server } = message
                    && *t == task_id
                    && let Some(tx) = tx.borrow_mut().take()
                {
                    let _ = tx.send(mcp_server.clone());
                }
            });
            inner.connection.send_ctl(&CtlMessage::McpOpen { task_id: inner.task_id.clone() })?;
            let timeout = inner.connection.executor().timer(OPEN_TIMEOUT);
            let result = match futures::future::select(rx, timeout).await {
                Either::Left((Ok(spec), _)) => {
                    *inner.mcp_server.borrow_mut() = Some(spec);
                    Ok(())
                }
                _ => Err(TransportError::new(TransportErrorKind::SpawnFailed, "mcp-open timed out")),
            };
            drop(opened);
            result
        }
        .boxed_local()
    }

    pub fn on_request(&self, callback: impl Fn(&str, McpRespond) + 'static) -> Subscription {
        self.inner.requests.borrow().subscribe(move |(line, respond)| callback(line, respond.clone()))
    }

    pub fn close(&self) {
        if self.inner.closed.replace(true) {
            return;
        }
        // Idempotent on the worker: it closes listeners on exit/disconnect.
        let _ = self.inner.connection.send_ctl(&CtlMessage::McpClose { task_id: self.inner.task_id.clone() });
        drop(std::mem::take(&mut *self.inner.subscriptions.borrow_mut()));
        *self.inner.requests.borrow_mut() = Listeners::new();
    }
}
