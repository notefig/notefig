//! Newline-delimited JSON-RPC 2.0 over any byte stream pair, on a
//! single-threaded executor. Used for the ACP client (and by the tests'
//! fake agent). Incoming notifications are handled synchronously in read
//! order, so every `session/update` before a response is applied before
//! the awaiting caller resumes (replay-before-`session/load` ordering).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;

use serde_json::{Value, json};
use smol::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use smol::stream::StreamExt;

pub type LocalBoxFuture<T> = Pin<Box<dyn Future<Output = T>>>;
pub type Spawner = Rc<smol::LocalExecutor<'static>>;

#[derive(Debug, Clone, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn new(code: i64, message: impl Into<String>) -> Self {
        RpcError {
            code,
            message: message.into(),
            data: None,
        }
    }
    pub fn method_not_found(method: &str) -> Self {
        RpcError::new(-32601, format!("method not found: {method}"))
    }
    pub fn internal(message: impl Into<String>) -> Self {
        RpcError::new(-32603, message)
    }
    pub fn closed() -> Self {
        RpcError::new(-32000, "agent process ended")
    }
    fn from_json(v: &Value) -> Self {
        RpcError {
            code: v.get("code").and_then(Value::as_i64).unwrap_or(-32603),
            message: v
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
                .to_string(),
            data: v.get("data").cloned(),
        }
    }
    fn to_json(&self) -> Value {
        let mut v = json!({"code": self.code, "message": self.message});
        if let Some(data) = &self.data {
            v["data"] = data.clone();
        }
        v
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)?;
        // Agents often put the useful detail in `data` (e.g. "Authentication required").
        if let Some(data) = &self.data {
            let detail = match data {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            if !detail.is_empty() && detail != "null" && !self.message.contains(&detail) {
                write!(f, ": {detail}")?;
            }
        }
        Ok(())
    }
}

/// What the remote side may ask of us.
pub trait RpcHandler {
    fn request(&self, method: String, params: Value) -> LocalBoxFuture<Result<Value, RpcError>>;
    fn notification(&self, method: String, params: Value);
}

type PendingMap = HashMap<i64, async_channel::Sender<Result<Value, RpcError>>>;

pub struct RpcConnection {
    out: async_channel::Sender<String>,
    pending: Rc<RefCell<PendingMap>>,
    next_id: Cell<i64>,
    closed: Rc<Cell<bool>>,
}

impl RpcConnection {
    /// Start the reader and writer tasks. `on_line` sees every raw line
    /// (diagnostics); `on_close` fires once, after the read side ends and
    /// every pending request has been failed.
    pub fn start(
        spawner: &Spawner,
        reader: impl AsyncRead + Unpin + 'static,
        mut writer: impl AsyncWrite + Unpin + 'static,
        handler: Rc<dyn RpcHandler>,
        on_close: impl FnOnce() + 'static,
    ) -> Rc<RpcConnection> {
        let (out_tx, out_rx) = async_channel::unbounded::<String>();
        let pending: Rc<RefCell<PendingMap>> = Rc::default();
        let closed = Rc::new(Cell::new(false));
        spawner
            .spawn(async move {
                while let Ok(line) = out_rx.recv().await {
                    let mut bytes = line.into_bytes();
                    bytes.push(b'\n');
                    if writer.write_all(&bytes).await.is_err() || writer.flush().await.is_err() {
                        break;
                    }
                }
                let _ = writer.close().await;
            })
            .detach();
        let conn = Rc::new(RpcConnection {
            out: out_tx.clone(),
            pending: pending.clone(),
            next_id: Cell::new(0),
            closed: closed.clone(),
        });
        let spawner2 = spawner.clone();
        spawner
            .spawn(async move {
                let mut lines = BufReader::new(reader).lines();
                while let Some(Ok(line)) = lines.next().await {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(message) = serde_json::from_str::<Value>(line) else { continue };
                    let method = message.get("method").and_then(Value::as_str).map(str::to_string);
                    let id = message.get("id").cloned().filter(|v| !v.is_null());
                    match (method, id) {
                        (Some(method), Some(id)) => {
                            let params = message.get("params").cloned().unwrap_or(Value::Null);
                            let fut = handler.request(method, params);
                            let out = out_tx.clone();
                            spawner2
                                .spawn(async move {
                                    let response = match fut.await {
                                        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
                                        Err(error) => json!({"jsonrpc": "2.0", "id": id, "error": error.to_json()}),
                                    };
                                    let _ = out.send(response.to_string()).await;
                                })
                                .detach();
                        }
                        (Some(method), None) => {
                            handler.notification(method, message.get("params").cloned().unwrap_or(Value::Null));
                        }
                        (None, Some(id)) => {
                            let Some(id) = id.as_i64() else { continue };
                            let sender = pending.borrow_mut().remove(&id);
                            if let Some(sender) = sender {
                                let result = match message.get("error") {
                                    Some(error) if !error.is_null() => Err(RpcError::from_json(error)),
                                    _ => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                                };
                                let _ = sender.try_send(result);
                            }
                        }
                        (None, None) => {}
                    }
                }
                closed.set(true);
                out_tx.close();
                for (_, sender) in pending.borrow_mut().drain() {
                    let _ = sender.try_send(Err(RpcError::closed()));
                }
                on_close();
            })
            .detach();
        conn
    }

    pub fn is_closed(&self) -> bool {
        self.closed.get()
    }

    /// Send a request and await its response.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        if self.closed.get() {
            return Err(RpcError::closed());
        }
        let id = self.next_id.get();
        self.next_id.set(id + 1);
        let (tx, rx) = async_channel::bounded(1);
        self.pending.borrow_mut().insert(id, tx);
        let message = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        if self.out.send(message.to_string()).await.is_err() {
            self.pending.borrow_mut().remove(&id);
            return Err(RpcError::closed());
        }
        rx.recv().await.unwrap_or_else(|_| Err(RpcError::closed()))
    }

    pub fn notify(&self, method: &str, params: Value) {
        let message = json!({"jsonrpc": "2.0", "method": method, "params": params});
        let _ = self.out.try_send(message.to_string());
    }

    /// Stop writing (closes the peer's stdin once queued lines drain).
    pub fn close(&self) {
        self.out.close();
    }
}
