//! Route a harness through the tunnel: a
//! [`notefig_agent::process::TransportFactory`] whose transports are
//! [`TunnelTransport`]s. This is the seam the TS web build uses
//! (`base-browser-adapter.ts` hands `TunnelTransport` to the agent service);
//! the Rust agent runtime runs on its own thread, so the bridge crosses
//! threads with channels:
//!
//! - [`TunnelBridge::new`] (main thread) owns the tunnel connection and
//!   pumps open requests;
//! - [`TunnelTransportFactory`] (`Send + Sync`) is what the agents module
//!   is handed. `open(spec)` asks the main thread to `start-task` on the
//!   worker and returns a [`Transport`] whose reader yields the worker's
//!   ACP lines, whose writer sends ACP lines, whose stderr is the worker's
//!   `task-diagnostic` lines and whose `exit` resolves on `task-exit` or
//!   tunnel loss. Dropping the writer stops the task (`stop-task`).
//!
//! The worker spawns harnesses it knows by id: [`TunnelSpawn::from_spec`]
//! takes the spec's `harness_id`, `task_id` and `cwd`; a root can hand
//! [`TunnelBridge::factory_with`] another mapping (per-task env, say).

use std::collections::BTreeMap;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use futures::channel::oneshot;
use futures::{AsyncRead, AsyncWrite, Stream};
use notefig_agent::process::{ProcError, ProcErrorKind, SpawnSpec, Transport, TransportFactory};
use notefig_core::{ExecutorExt, Subscription};

use crate::connection::TunnelConnection;
use crate::transport::{TunnelTransport, TunnelTransportSpec};

/// What the worker needs to start a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelSpawn {
    pub task_id: String,
    pub harness_id: String,
    /// The cwd sent with `start-task`.
    pub workspace_path: String,
    /// Per-task env on top of the harness's static env (e.g. OPENCODE_CONFIG).
    pub extra_env: BTreeMap<String, String>,
}

impl TunnelSpawn {
    /// What a spawn spec asks the worker for; the program, args and env are
    /// this machine's and mean nothing there.
    pub fn from_spec(spec: &SpawnSpec) -> Self {
        Self {
            task_id: spec.task_id.clone(),
            harness_id: spec.harness_id.clone(),
            workspace_path: spec.cwd.display().to_string(),
            extra_env: BTreeMap::new(),
        }
    }
}

/// The streams of one task, handed from the main thread to the agent thread.
struct Opened {
    lines: async_channel::Receiver<String>,
    diagnostics: async_channel::Receiver<String>,
    exit: async_channel::Receiver<Option<i32>>,
    outgoing: async_channel::Sender<String>,
}

struct OpenRequest {
    spawn: TunnelSpawn,
    reply: oneshot::Sender<Result<Opened, ProcError>>,
}

/// The main-thread half. Keep it alive as long as tasks may open.
pub struct TunnelBridge {
    requests: async_channel::Sender<OpenRequest>,
    _pump: Subscription,
}

pub type SpawnResolver = Arc<dyn Fn(&SpawnSpec) -> TunnelSpawn + Send + Sync>;

impl TunnelBridge {
    pub fn new(connection: TunnelConnection) -> Self {
        let (requests, incoming) = async_channel::unbounded::<OpenRequest>();
        let executor = connection.executor();
        let stop = incoming.clone();
        executor.spawn_local(async move {
            while let Ok(request) = incoming.recv().await {
                connection.executor().spawn_local(open_on_main(connection.clone(), request));
            }
        });
        Self {
            requests,
            _pump: Subscription::new(move || {
                stop.close();
            }),
        }
    }

    /// The factory for the agent runtime (`AgentsDeps.transport`).
    pub fn factory(&self) -> Arc<dyn TransportFactory> {
        self.factory_with(Arc::new(TunnelSpawn::from_spec))
    }

    /// The factory, mapping specs with `resolve`.
    pub fn factory_with(&self, resolve: SpawnResolver) -> Arc<dyn TransportFactory> {
        Arc::new(TunnelTransportFactory { requests: self.requests.clone(), resolve })
    }
}

/// [`TransportFactory`] over the tunnel; `Send + Sync`.
pub struct TunnelTransportFactory {
    requests: async_channel::Sender<OpenRequest>,
    resolve: SpawnResolver,
}

fn spawn_failed(message: impl Into<String>) -> ProcError {
    ProcError { kind: ProcErrorKind::SpawnFailed, message: message.into() }
}

impl TransportFactory for TunnelTransportFactory {
    fn open(&self, spec: SpawnSpec) -> Pin<Box<dyn std::future::Future<Output = Result<Transport, ProcError>>>> {
        let spawn = (self.resolve)(&spec);
        let requests = self.requests.clone();
        Box::pin(async move {
            let (reply, opened) = oneshot::channel();
            requests
                .send(OpenRequest { spawn, reply })
                .await
                .map_err(|_| spawn_failed("the tunnel bridge is gone"))?;
            let opened = opened.await.map_err(|_| spawn_failed("the tunnel bridge is gone"))??;
            let exit = opened.exit;
            Ok(Transport {
                reader: Box::new(LineReader::new(opened.lines)),
                writer: Box::new(LineWriter { outgoing: opened.outgoing, buffer: Vec::new() }),
                stderr: Some(Box::new(LineReader::new(opened.diagnostics))),
                guard: None,
                exit: Some(smol::spawn(async move { exit.recv().await.ok().flatten() })),
            })
        })
    }
}

async fn open_on_main(connection: TunnelConnection, request: OpenRequest) {
    let OpenRequest { spawn, reply } = request;
    let transport = TunnelTransport::new(
        TunnelTransportSpec {
            task_id: spawn.task_id,
            harness_id: spawn.harness_id,
            workspace_path: spawn.workspace_path,
            extra_env: spawn.extra_env,
        },
        connection.clone(),
    );
    let (lines_tx, lines) = async_channel::unbounded();
    let (diag_tx, diagnostics) = async_channel::unbounded();
    let (exit_tx, exit) = async_channel::bounded(1);
    let (outgoing, outgoing_rx) = async_channel::unbounded::<String>();
    let subs = vec![
        transport.on_line(move |line| {
            let _ = lines_tx.try_send(line.to_string());
        }),
        transport.on_diagnostic(move |line| {
            let _ = diag_tx.try_send(line.to_string());
        }),
        transport.on_close(move |error| {
            let _ = exit_tx.try_send(if error.is_none() { Some(0) } else { None });
            exit_tx.close();
        }),
    ];
    if let Err(error) = transport.start().await {
        let _ = reply.send(Err(spawn_failed(error.message)));
        return;
    }
    if reply.send(Ok(Opened { lines, diagnostics, exit, outgoing })).is_err() {
        transport.close();
        return;
    }
    // Writer → worker until the agent side drops its writer.
    while let Ok(line) = outgoing_rx.recv().await {
        transport.send(&line);
    }
    transport.close();
    drop(subs);
}

/// Lines from a channel as a byte stream, each ended with `\n`.
struct LineReader {
    lines: Pin<Box<async_channel::Receiver<String>>>,
    pending: Vec<u8>,
    offset: usize,
}

impl LineReader {
    fn new(lines: async_channel::Receiver<String>) -> Self {
        Self { lines: Box::pin(lines), pending: Vec::new(), offset: 0 }
    }
}

impl AsyncRead for LineReader {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut [u8]) -> Poll<std::io::Result<usize>> {
        loop {
            if self.offset < self.pending.len() {
                let n = buf.len().min(self.pending.len() - self.offset);
                let start = self.offset;
                buf[..n].copy_from_slice(&self.pending[start..start + n]);
                self.offset += n;
                return Poll::Ready(Ok(n));
            }
            match self.lines.as_mut().poll_next(cx) {
                Poll::Ready(Some(line)) => {
                    let mut bytes = line.into_bytes();
                    bytes.push(b'\n');
                    self.pending = bytes;
                    self.offset = 0;
                }
                Poll::Ready(None) => return Poll::Ready(Ok(0)),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// Bytes written, sent on as whole lines.
struct LineWriter {
    outgoing: async_channel::Sender<String>,
    buffer: Vec<u8>,
}

impl AsyncWrite for LineWriter {
    fn poll_write(mut self: Pin<&mut Self>, _cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        self.buffer.extend_from_slice(buf);
        while let Some(end) = self.buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
            if !text.is_empty() && self.outgoing.try_send(text).is_err() {
                return Poll::Ready(Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "tunnel task closed")));
            }
        }
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_close(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.outgoing.close();
        Poll::Ready(Ok(()))
    }
}
