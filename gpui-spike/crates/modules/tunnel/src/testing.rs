//! The worker's protocol side as a test double — a port of
//! `__tests__/fake-worker.ts`: an in-memory socket pair plus the
//! hello/pair/pair-ack handshake, ctl task lifecycle and mcp plumbing,
//! built only on [`crate::protocol`] (the pinned vectors keep it honest
//! against the CLI's real worker).
//!
//! Deviation: TS runs a scripted `FakeAgent` per task over a loopback pair.
//! Here a task's ACP lines are recorded ([`FakeWorker::acp_received`]) and
//! the test answers with [`FakeWorker::send_acp`]; the agents crate's own
//! fake agent covers the turn machinery.
//!
//! [`WorkerPeer`] is the protocol state machine alone (raw text in, raw
//! text out), so the same worker can sit behind a real WebSocket server.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use crate::connection::{SocketEvent, TunnelSocket, TunnelSocketFactory};
use crate::protocol::encoding::bytes_to_base64;
use crate::protocol::{
    CtlMessage, FrameCipher, HarnessAdvert, InnerFrame, McpServerSpec, EnvVar, TUNNEL_PROTOCOL_VERSION, TunnelChannel,
    TunnelEnvelope, TunnelErrorCode, TunnelRole, WorkerInfo, derive_frame_key, derive_session_key,
    generate_pairing_secret,
};

#[derive(Debug, Clone)]
pub struct FakeWorkerOptions {
    pub workspace_path: String,
    pub worker_name: String,
    pub harnesses: Vec<HarnessAdvert>,
    pub protocol: i64,
    /// Reject start-task for this harness id with this message.
    pub spawn_error: Option<(String, String)>,
}

impl Default for FakeWorkerOptions {
    fn default() -> Self {
        Self {
            workspace_path: "/remote/ws".into(),
            worker_name: "fake-worker".into(),
            harnesses: vec![
                HarnessAdvert { id: "claude-code".into(), available: true },
                HarnessAdvert { id: "opencode".into(), available: true },
            ],
            protocol: TUNNEL_PROTOCOL_VERSION as i64,
            spawn_error: None,
        }
    }
}

/// One connection's worker side: text frames in, text frames out.
pub struct WorkerPeer {
    secret: Vec<u8>,
    options: FakeWorkerOptions,
    cipher: FrameCipher,
    challenge: String,
    paired: bool,
    /// Every ctl message received, in order.
    pub received_ctl: Vec<CtlMessage>,
    /// Started tasks and the ACP lines each received.
    pub tasks: BTreeMap<String, Vec<String>>,
    /// MCP lines received per (task, conn).
    pub mcp_received: BTreeMap<(String, u64), Vec<String>>,
    pub failed: bool,
}

impl WorkerPeer {
    /// A fresh connection: returns the peer and its `hello`.
    pub fn new(secret: &[u8], options: FakeWorkerOptions) -> (Self, String) {
        let mut challenge_bytes = [0u8; 16];
        getrandom::fill(&mut challenge_bytes).expect("randomness");
        let challenge = bytes_to_base64(&challenge_bytes);
        let frame_key = derive_frame_key(secret).expect("32-byte secret");
        let session_key = derive_session_key(&frame_key, &challenge_bytes);
        let hello = TunnelEnvelope::Hello { challenge: challenge.clone() }.to_json();
        (
            Self {
                secret: secret.to_vec(),
                options,
                cipher: FrameCipher::new(&session_key, TunnelRole::Worker).unwrap(),
                challenge,
                paired: false,
                received_ctl: Vec::new(),
                tasks: BTreeMap::new(),
                mcp_received: BTreeMap::new(),
                failed: false,
            },
            hello,
        )
    }

    pub fn secret(&self) -> &[u8] {
        &self.secret
    }

    pub fn seal(&mut self, inner: &InnerFrame) -> String {
        TunnelEnvelope::Frame(self.cipher.seal(inner)).to_json()
    }

    pub fn seal_ctl(&mut self, message: &CtlMessage) -> String {
        self.seal(&InnerFrame::ctl(message))
    }

    fn pairing_failed() -> String {
        TunnelEnvelope::Error { code: TunnelErrorCode::PairingFailed, message: "pairing failed".into() }.to_json()
    }

    /// Handle one text frame from the app; returns what to send back. When
    /// `failed` turns true the caller drops the connection.
    pub fn handle(&mut self, raw: &str) -> Vec<String> {
        let Ok(TunnelEnvelope::Frame(envelope)) = TunnelEnvelope::parse(raw) else {
            return Vec::new();
        };
        let Some(inner) = self.cipher.open(&envelope) else {
            self.failed = true;
            return vec![Self::pairing_failed()];
        };
        if !self.paired {
            let pair = match (inner.ch, &inner.data) {
                (TunnelChannel::Ctl, Some(data)) => CtlMessage::parse(data),
                _ => None,
            };
            match pair {
                Some(CtlMessage::Pair { challenge }) if challenge == self.challenge => {}
                _ => {
                    self.failed = true;
                    return vec![Self::pairing_failed()];
                }
            }
            self.paired = true;
            let worker = WorkerInfo {
                name: self.options.worker_name.clone(),
                workspace_path: self.options.workspace_path.clone(),
                harnesses: self.options.harnesses.clone(),
                protocol: self.options.protocol,
            };
            return vec![self.seal_ctl(&CtlMessage::PairAck { worker })];
        }
        match inner.ch {
            TunnelChannel::Acp => {
                if let (Some(task), Some(serde_json::Value::String(line))) = (inner.task_id, inner.data)
                    && let Some(lines) = self.tasks.get_mut(&task)
                {
                    lines.push(line);
                }
                Vec::new()
            }
            TunnelChannel::Mcp => {
                if let (Some(task), Some(conn), Some(serde_json::Value::String(line))) =
                    (inner.task_id, inner.conn_id, inner.data)
                {
                    self.mcp_received.entry((task, conn)).or_default().push(line);
                }
                Vec::new()
            }
            TunnelChannel::Ctl => {
                let Some(message) = inner.data.as_ref().and_then(CtlMessage::parse) else {
                    return Vec::new();
                };
                self.received_ctl.push(message.clone());
                self.handle_ctl(message)
            }
        }
    }

    fn handle_ctl(&mut self, message: CtlMessage) -> Vec<String> {
        match message {
            CtlMessage::StartTask { task_id, harness_id, .. } => {
                if let Some((id, error)) = &self.options.spawn_error
                    && *id == harness_id
                {
                    let reply = CtlMessage::TaskSpawnError { task_id, message: error.clone() };
                    return vec![self.seal_ctl(&reply)];
                }
                self.tasks.insert(task_id.clone(), Vec::new());
                vec![self.seal_ctl(&CtlMessage::TaskStarted { task_id })]
            }
            CtlMessage::StopTask { task_id } => {
                self.tasks.remove(&task_id);
                Vec::new()
            }
            CtlMessage::McpOpen { task_id } => {
                let reply = CtlMessage::McpOpened {
                    task_id,
                    mcp_server: McpServerSpec {
                        name: "notefig".into(),
                        command: "/usr/bin/node".into(),
                        args: vec!["/worker/cli.js".into(), "mcp-relay".into(), "--port".into(), "12345".into()],
                        env: vec![EnvVar { name: "NOTEFIG_MCP_TOKEN".into(), value: "fake-token".into() }],
                    },
                };
                vec![self.seal_ctl(&reply)]
            }
            _ => Vec::new(),
        }
    }
}

struct Live {
    peer: WorkerPeer,
    events: async_channel::Sender<SocketEvent>,
    closed: bool,
}

/// `FakeWorker`: hand [`FakeWorker::socket_factory`] to the connection.
#[derive(Clone)]
pub struct FakeWorker {
    inner: Rc<WorkerInner>,
}

struct WorkerInner {
    secret: RefCell<Vec<u8>>,
    options: FakeWorkerOptions,
    live: RefCell<Option<Live>>,
    /// Ctl messages from every connection so far.
    history: RefCell<Vec<CtlMessage>>,
    next_conn_id: RefCell<u64>,
    /// Every URL a socket was opened to.
    pub urls: RefCell<Vec<String>>,
}

struct FakeSocket {
    worker: std::rc::Weak<WorkerInner>,
}

impl TunnelSocket for FakeSocket {
    fn send(&self, data: String) {
        if let Some(worker) = self.worker.upgrade() {
            FakeWorker { inner: worker }.from_app(&data);
        }
    }

    fn close(&self) {
        if let Some(worker) = self.worker.upgrade() {
            FakeWorker { inner: worker }.drop_connection();
        }
    }
}

impl FakeWorker {
    pub fn new(options: FakeWorkerOptions) -> Self {
        Self {
            inner: Rc::new(WorkerInner {
                secret: RefCell::new(generate_pairing_secret().to_vec()),
                options,
                live: RefCell::default(),
                history: RefCell::default(),
                next_conn_id: RefCell::new(1),
                urls: RefCell::default(),
            }),
        }
    }

    pub fn secret(&self) -> Vec<u8> {
        self.inner.secret.borrow().clone()
    }

    /// Answer with another secret from the next connection on.
    pub fn set_secret(&self, secret: Vec<u8>) {
        *self.inner.secret.borrow_mut() = secret;
    }

    pub fn code(&self) -> String {
        crate::protocol::encode_pairing_code(&self.secret(), "wss://fake.example").unwrap()
    }

    pub fn socket_factory(&self) -> TunnelSocketFactory {
        let worker = self.clone();
        Rc::new(move |url: &str| {
            worker.inner.urls.borrow_mut().push(url.to_string());
            let (tx, rx) = async_channel::unbounded();
            let (peer, hello) = WorkerPeer::new(&worker.secret(), worker.inner.options.clone());
            let _ = tx.try_send(SocketEvent::Open);
            let _ = tx.try_send(SocketEvent::Message(hello));
            *worker.inner.live.borrow_mut() = Some(Live { peer, events: tx, closed: false });
            (Rc::new(FakeSocket { worker: Rc::downgrade(&worker.inner) }) as Rc<dyn TunnelSocket>, rx)
        })
    }

    fn from_app(&self, raw: &str) {
        let (replies, failed) = {
            let mut live = self.inner.live.borrow_mut();
            let Some(live) = live.as_mut().filter(|l| !l.closed) else { return };
            let before = live.peer.received_ctl.len();
            let replies = live.peer.handle(raw);
            self.inner.history.borrow_mut().extend(live.peer.received_ctl[before..].iter().cloned());
            (replies, live.peer.failed)
        };
        for reply in replies {
            self.to_app(reply);
        }
        if failed {
            self.drop_connection();
        }
    }

    fn to_app(&self, raw: String) {
        if let Some(live) = self.inner.live.borrow().as_ref().filter(|l| !l.closed) {
            let _ = live.events.try_send(SocketEvent::Message(raw));
        }
    }

    fn seal_and_send(&self, f: impl FnOnce(&mut WorkerPeer) -> String) {
        let raw = {
            let mut live = self.inner.live.borrow_mut();
            let Some(live) = live.as_mut().filter(|l| !l.closed) else { return };
            f(&mut live.peer)
        };
        self.to_app(raw);
    }

    /// Kill the connection from the worker side (a tunnel drop).
    pub fn drop_connection(&self) {
        if let Some(live) = self.inner.live.borrow_mut().as_mut()
            && !live.closed
        {
            live.closed = true;
            let _ = live.events.try_send(SocketEvent::Close);
            live.events.close();
        }
    }

    pub fn received_ctl(&self) -> Vec<CtlMessage> {
        self.inner.history.borrow().clone()
    }

    /// The ACP lines a started task received (None if not running).
    pub fn acp_received(&self, task_id: &str) -> Option<Vec<String>> {
        self.inner.live.borrow().as_ref()?.peer.tasks.get(task_id).cloned()
    }

    pub fn mcp_received(&self, task_id: &str, conn_id: u64) -> Vec<String> {
        self.inner
            .live
            .borrow()
            .as_ref()
            .and_then(|l| l.peer.mcp_received.get(&(task_id.to_string(), conn_id)).cloned())
            .unwrap_or_default()
    }

    /// The worker's adapter printed `data` (one or more lines) on stdout.
    pub fn send_acp(&self, task_id: &str, data: &str) {
        let inner = InnerFrame {
            ch: TunnelChannel::Acp,
            task_id: Some(task_id.into()),
            conn_id: None,
            data: Some(data.into()),
        };
        self.seal_and_send(|peer| peer.seal(&inner));
    }

    pub fn exit_task(&self, task_id: &str, code: Option<i64>) {
        if let Some(live) = self.inner.live.borrow_mut().as_mut() {
            live.peer.tasks.remove(task_id);
        }
        let message = CtlMessage::TaskExit { task_id: task_id.into(), code };
        self.seal_and_send(|peer| peer.seal_ctl(&message));
    }

    pub fn emit_diagnostic(&self, task_id: &str, line: &str) {
        let message = CtlMessage::TaskDiagnostic { task_id: task_id.into(), line: line.into() };
        self.seal_and_send(|peer| peer.seal_ctl(&message));
    }

    /// A harness-spawned MCP relay connection: returns its conn id; send
    /// with [`Self::mcp_send`], read replies with [`Self::mcp_received`].
    pub fn mcp_connect(&self) -> u64 {
        let mut next = self.inner.next_conn_id.borrow_mut();
        let id = *next;
        *next += 1;
        id
    }

    pub fn mcp_send(&self, task_id: &str, conn_id: u64, line: &str) {
        let inner = InnerFrame {
            ch: TunnelChannel::Mcp,
            task_id: Some(task_id.into()),
            conn_id: Some(conn_id),
            data: Some(line.into()),
        };
        self.seal_and_send(|peer| peer.seal(&inner));
    }
}
