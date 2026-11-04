//! The one connection to a `notefig agent` worker: socket + pairing
//! handshake + encrypted frame mux/demux, exposed as per-channel
//! sub-surfaces (acp / mcp / ctl). A port of `tunnel-connection.ts`.
//!
//! Lifecycle contract (as TS): on socket loss the async disconnect handlers
//! run FIRST (task disposal), then the state turns `Disconnected`, then the
//! sync `on_closed` listeners fire (transports surface `peer_disconnected`).
//!
//! Deviations:
//! - TS keeps a module-level singleton; here the connection is built by
//!   [`create_tunnel_connection`] and owned by the tunnel module (`core.tunnel`).
//! - A socket's events arrive on a channel the connection pumps, and every
//!   connect attempt has a generation: events from a socket the connection
//!   already gave up on (a failed handshake it closed) are ignored, where TS
//!   let that late `close` run the drop pipeline against a dead attempt.
//! - Effect's `Deferred` + forked timeout is a oneshot raced against
//!   `executor.timer`.

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::{Either, LocalBoxFuture};
use notefig_core::{Executor, ExecutorExt, Listeners, Subscription};

use crate::protocol::encoding::base64_to_bytes;
use crate::protocol::{
    CtlMessage, FrameCipher, InnerFrame, TUNNEL_PROTOCOL_VERSION, TunnelChannel, TunnelEnvelope, TunnelErrorCode,
    TunnelRole, WorkerInfo, derive_frame_key, derive_session_key,
};

pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);

const PROTOCOL_MISMATCH: &str = "protocol mismatch — update the notefig CLI and the app to matching versions";

/// `AgentTransportError["type"]`, the kinds the tunnel produces.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportErrorKind {
    RelayUnreachable,
    PairingFailed,
    PeerDisconnected,
    DecryptFailed,
    SpawnFailed,
    Closed,
    Unknown,
}

impl TransportErrorKind {
    /// The TS wire name (`"relay_unreachable"`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RelayUnreachable => "relay_unreachable",
            Self::PairingFailed => "pairing_failed",
            Self::PeerDisconnected => "peer_disconnected",
            Self::DecryptFailed => "decrypt_failed",
            Self::SpawnFailed => "spawn_failed",
            Self::Closed => "closed",
            Self::Unknown => "unknown",
        }
    }
}

/// `AgentTransportError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportError {
    pub kind: TransportErrorKind,
    pub message: String,
}

impl TransportError {
    pub fn new(kind: TransportErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TransportError {}

/// What a socket reports, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum SocketEvent {
    Open,
    Message(String),
    Close,
    Error(String),
}

/// The minimal socket surface (`TunnelSocket`), injectable so tests run an
/// in-memory pair. Closing must eventually deliver [`SocketEvent::Close`].
pub trait TunnelSocket {
    fn send(&self, data: String);
    fn close(&self);
}

/// Opens a socket to `url`: the socket and the stream of its events.
pub type TunnelSocketFactory =
    Rc<dyn Fn(&str) -> (Rc<dyn TunnelSocket>, async_channel::Receiver<SocketEvent>)>;

#[derive(Debug, Clone, PartialEq)]
pub enum TunnelConnectionState {
    Disconnected { error: Option<String> },
    Connecting,
    Connected { worker_info: WorkerInfo },
}

impl TunnelConnectionState {
    pub fn is_connected(&self) -> bool {
        matches!(self, Self::Connected { .. })
    }
    pub fn is_disconnected(&self) -> bool {
        matches!(self, Self::Disconnected { .. })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelPairing {
    pub secret: Vec<u8>,
    pub url: String,
}

type DisconnectHandler = Rc<dyn Fn() -> LocalBoxFuture<'static, ()>>;
type HandshakeResult = Result<WorkerInfo, TransportError>;

/// `TunnelConnection`. Cheap to clone; every clone is the same connection.
#[derive(Clone)]
pub struct TunnelConnection {
    inner: Rc<Inner>,
}

struct Inner {
    executor: Rc<dyn Executor>,
    factory: RefCell<TunnelSocketFactory>,
    socket: RefCell<Option<Rc<dyn TunnelSocket>>>,
    cipher: RefCell<Option<FrameCipher>>,
    generation: Cell<u64>,
    state: RefCell<TunnelConnectionState>,
    state_listeners: Listeners<()>,
    acp: Listeners<(String, String)>,
    mcp: Listeners<(String, u64, String)>,
    ctl: Listeners<CtlMessage>,
    closed: Listeners<TransportError>,
    disconnect_handlers: RefCell<Vec<(u64, DisconnectHandler)>>,
    next_handler: Cell<u64>,
    handshake: RefCell<Option<oneshot::Sender<HandshakeResult>>>,
}

/// A connection that opens sockets with `factory` (the real one is
/// [`crate::websocket_factory`]).
pub fn create_tunnel_connection(executor: Rc<dyn Executor>, factory: TunnelSocketFactory) -> TunnelConnection {
    TunnelConnection {
        inner: Rc::new(Inner {
            executor,
            factory: RefCell::new(factory),
            socket: RefCell::default(),
            cipher: RefCell::default(),
            generation: Cell::new(0),
            state: RefCell::new(TunnelConnectionState::Disconnected { error: None }),
            state_listeners: Listeners::new(),
            acp: Listeners::new(),
            mcp: Listeners::new(),
            ctl: Listeners::new(),
            closed: Listeners::new(),
            disconnect_handlers: RefCell::default(),
            next_handler: Cell::new(0),
            handshake: RefCell::default(),
        }),
    }
}

/// Split a batched frame payload into lines, dropping empties.
fn split_lines(data: &str) -> impl Iterator<Item = &str> {
    data.split('\n').filter(|l| !l.is_empty())
}

impl TunnelConnection {
    pub fn state(&self) -> TunnelConnectionState {
        self.inner.state.borrow().clone()
    }

    pub fn worker_info(&self) -> Option<WorkerInfo> {
        match &*self.inner.state.borrow() {
            TunnelConnectionState::Connected { worker_info } => Some(worker_info.clone()),
            _ => None,
        }
    }

    /// Fires on every state change (`useSyncExternalStore` shape).
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.inner.state_listeners.subscribe(move |_| listener())
    }

    /// Swap how sockets open (tests point it at a fake worker).
    pub fn set_socket_factory(&self, factory: TunnelSocketFactory) {
        *self.inner.factory.borrow_mut() = factory;
    }

    pub fn executor(&self) -> Rc<dyn Executor> {
        self.inner.executor.clone()
    }

    pub fn connect(&self, pairing: TunnelPairing) -> LocalBoxFuture<'static, HandshakeResult> {
        let inner = self.inner.clone();
        async move {
            if !inner.state.borrow().is_disconnected() {
                return Err(TransportError::new(
                    TransportErrorKind::Unknown,
                    "tunnel is already connected or connecting",
                ));
            }
            inner.set_state(TunnelConnectionState::Connecting);
            let result = Inner::handshake(&inner, pairing).await;
            match result {
                Ok(info) => {
                    inner.set_state(TunnelConnectionState::Connected { worker_info: info.clone() });
                    Ok(info)
                }
                Err(error) => {
                    // Abandon this attempt: its socket's late events are ignored.
                    inner.generation.set(inner.generation.get() + 1);
                    if let Some(socket) = inner.socket.borrow_mut().take() {
                        socket.close();
                    }
                    *inner.cipher.borrow_mut() = None;
                    inner.set_state(TunnelConnectionState::Disconnected { error: Some(error.message.clone()) });
                    Err(error)
                }
            }
        }
        .boxed_local()
    }

    /// Close the socket; the drop pipeline runs when it reports closed.
    pub fn disconnect(&self) {
        let socket = self.inner.socket.borrow().clone();
        if let Some(socket) = socket {
            socket.close();
        }
    }

    pub fn send_acp(&self, task_id: &str, line: &str) -> Result<(), TransportError> {
        self.inner.send_frame(&InnerFrame {
            ch: TunnelChannel::Acp,
            task_id: Some(task_id.into()),
            conn_id: None,
            data: Some(line.into()),
        })
    }

    pub fn on_acp(&self, callback: impl Fn(&str, &str) + 'static) -> Subscription {
        self.inner.acp.subscribe(move |(task, line)| callback(task, line))
    }

    pub fn send_mcp(&self, task_id: &str, conn_id: u64, line: &str) -> Result<(), TransportError> {
        self.inner.send_frame(&InnerFrame {
            ch: TunnelChannel::Mcp,
            task_id: Some(task_id.into()),
            conn_id: Some(conn_id),
            data: Some(line.into()),
        })
    }

    pub fn on_mcp(&self, callback: impl Fn(&str, u64, &str) + 'static) -> Subscription {
        self.inner.mcp.subscribe(move |(task, conn, line)| callback(task, *conn, line))
    }

    pub fn send_ctl(&self, message: &CtlMessage) -> Result<(), TransportError> {
        self.inner.send_frame(&InnerFrame::ctl(message))
    }

    pub fn on_ctl(&self, callback: impl Fn(&CtlMessage) + 'static) -> Subscription {
        self.inner.ctl.subscribe(callback)
    }

    /// Async work that must finish before `on_closed` fires (task disposal).
    pub fn on_disconnect(&self, handler: impl Fn() -> LocalBoxFuture<'static, ()> + 'static) -> Subscription {
        let id = self.inner.next_handler.get() + 1;
        self.inner.next_handler.set(id);
        self.inner.disconnect_handlers.borrow_mut().push((id, Rc::new(handler)));
        let weak = Rc::downgrade(&self.inner);
        Subscription::new(move || {
            if let Some(inner) = weak.upgrade() {
                inner.disconnect_handlers.borrow_mut().retain(|(i, _)| *i != id);
            }
        })
    }

    /// Transport-level notification, after the disconnect pipeline.
    pub fn on_closed(&self, callback: impl Fn(&TransportError) + 'static) -> Subscription {
        self.inner.closed.subscribe(callback)
    }
}

impl Inner {
    fn set_state(&self, state: TunnelConnectionState) {
        *self.state.borrow_mut() = state;
        self.state_listeners.emit();
    }

    fn handshake(this: &Rc<Self>, pairing: TunnelPairing) -> LocalBoxFuture<'static, HandshakeResult> {
        let generation = this.generation.get() + 1;
        this.generation.set(generation);
        let (tx, rx) = oneshot::channel();
        *this.handshake.borrow_mut() = Some(tx);
        let factory = this.factory.borrow().clone();
        let (socket, events) = factory(&pairing.url);
        *this.socket.borrow_mut() = Some(socket);
        this.executor.spawn_local(Self::pump(Rc::downgrade(this), generation, events, pairing.secret));
        let timeout = this.executor.timer(HANDSHAKE_TIMEOUT);
        let this = this.clone();
        async move {
            let result = match futures::future::select(rx, timeout).await {
                Either::Left((Ok(result), _)) => result,
                Either::Left((Err(_), _)) => Err(TransportError::new(
                    TransportErrorKind::PeerDisconnected,
                    "socket closed during handshake",
                )),
                Either::Right(_) => {
                    Err(TransportError::new(TransportErrorKind::RelayUnreachable, "handshake timed out"))
                }
            };
            this.handshake.borrow_mut().take();
            result
        }
        .boxed_local()
    }

    fn done(&self) -> bool {
        self.handshake.borrow().is_none()
    }

    fn settle(&self, result: HandshakeResult) {
        if let Some(tx) = self.handshake.borrow_mut().take() {
            let _ = tx.send(result);
        }
    }

    fn fail(&self, kind: TransportErrorKind, message: &str) {
        self.settle(Err(TransportError::new(kind, message)));
    }

    fn close_socket(&self) {
        let socket = self.socket.borrow().clone();
        if let Some(socket) = socket {
            socket.close();
        }
    }

    async fn pump(
        weak: Weak<Self>,
        generation: u64,
        events: async_channel::Receiver<SocketEvent>,
        secret: Vec<u8>,
    ) {
        while let Ok(event) = events.recv().await {
            let Some(this) = weak.upgrade() else { return };
            if this.generation.get() != generation {
                return;
            }
            match event {
                SocketEvent::Open => {}
                SocketEvent::Error(_) => this.fail(
                    TransportErrorKind::RelayUnreachable,
                    "could not reach the worker — is `notefig agent` still running?",
                ),
                SocketEvent::Close => {
                    if !this.done() {
                        this.fail(TransportErrorKind::PeerDisconnected, "socket closed during handshake");
                        return;
                    }
                    Self::socket_closed(&this).await;
                    return;
                }
                SocketEvent::Message(raw) => this.on_message(&raw, &secret),
            }
        }
    }

    fn on_message(&self, raw: &str, secret: &[u8]) {
        let envelope = match TunnelEnvelope::parse(raw) {
            Ok(envelope) => envelope,
            Err(_) => {
                // A version-mismatched hello also lands here.
                self.fail(TransportErrorKind::Unknown, PROTOCOL_MISMATCH);
                self.close_socket();
                return;
            }
        };
        match envelope {
            TunnelEnvelope::Error { code, message } => {
                let kind = match code {
                    TunnelErrorCode::PairingFailed => TransportErrorKind::PairingFailed,
                    TunnelErrorCode::Busy => TransportErrorKind::RelayUnreachable,
                    _ => TransportErrorKind::Unknown,
                };
                self.fail(kind, &message);
            }
            TunnelEnvelope::Hello { challenge } => {
                if self.cipher.borrow().is_some() {
                    return; // duplicate hello
                }
                let keys = derive_frame_key(secret)
                    .and_then(|frame_key| Ok(derive_session_key(&frame_key, &base64_to_bytes(&challenge)?)));
                let Ok(session_key) = keys else {
                    self.fail(TransportErrorKind::Unknown, PROTOCOL_MISMATCH);
                    self.close_socket();
                    return;
                };
                *self.cipher.borrow_mut() =
                    Some(FrameCipher::new(&session_key, TunnelRole::Browser).expect("32-byte key"));
                let _ = self.send_frame(&InnerFrame::ctl(&CtlMessage::Pair { challenge }));
            }
            TunnelEnvelope::Frame(frame) => {
                let inner = self.cipher.borrow_mut().as_mut().and_then(|c| c.open(&frame));
                let Some(inner) = inner else {
                    self.fail(TransportErrorKind::DecryptFailed, "bad frame");
                    self.close_socket();
                    return;
                };
                if !self.done() {
                    // The first decrypted frame must be pair-ack.
                    let ack = match (inner.ch, &inner.data) {
                        (TunnelChannel::Ctl, Some(data)) => CtlMessage::parse(data),
                        _ => None,
                    };
                    let Some(CtlMessage::PairAck { worker }) = ack else {
                        self.fail(TransportErrorKind::PairingFailed, "no pair-ack");
                        self.close_socket();
                        return;
                    };
                    if worker.protocol != TUNNEL_PROTOCOL_VERSION as i64 {
                        self.fail(TransportErrorKind::Unknown, PROTOCOL_MISMATCH);
                        self.close_socket();
                        return;
                    }
                    self.settle(Ok(worker));
                    return;
                }
                self.dispatch(inner);
            }
        }
    }

    async fn socket_closed(this: &Rc<Self>) {
        if this.state.borrow().is_disconnected() {
            return;
        }
        *this.socket.borrow_mut() = None;
        *this.cipher.borrow_mut() = None;
        let error = TransportError::new(TransportErrorKind::PeerDisconnected, "the worker connection dropped");
        // Disposal first (demotes tasks to "restored"), then the transports'
        // close listeners, whose tasks are already disposed.
        let handlers: Vec<DisconnectHandler> =
            this.disconnect_handlers.borrow().iter().map(|(_, h)| h.clone()).collect();
        for handler in handlers {
            handler().await;
        }
        this.set_state(TunnelConnectionState::Disconnected { error: Some(error.message.clone()) });
        this.closed.notify(&error);
    }

    fn send_frame(&self, inner: &InnerFrame) -> Result<(), TransportError> {
        let socket = self.socket.borrow().clone();
        let envelope = self.cipher.borrow_mut().as_mut().map(|cipher| cipher.seal(inner));
        let (Some(socket), Some(envelope)) = (socket, envelope) else {
            return Err(TransportError::new(TransportErrorKind::RelayUnreachable, "tunnel is not connected"));
        };
        socket.send(TunnelEnvelope::Frame(envelope).to_json());
        Ok(())
    }

    fn dispatch(&self, inner: InnerFrame) {
        match inner.ch {
            // A frame may batch several newline-delimited lines (the worker
            // coalesces a stdout chunk); splitting is lossless for NDJSON.
            TunnelChannel::Acp => {
                let (Some(task), Some(serde_json::Value::String(data))) = (inner.task_id, inner.data) else {
                    return;
                };
                for line in split_lines(&data) {
                    self.acp.notify(&(task.clone(), line.to_string()));
                }
            }
            TunnelChannel::Mcp => {
                let (Some(task), Some(conn), Some(serde_json::Value::String(data))) =
                    (inner.task_id, inner.conn_id, inner.data)
                else {
                    return;
                };
                for line in split_lines(&data) {
                    self.mcp.notify(&(task.clone(), conn, line.to_string()));
                }
            }
            TunnelChannel::Ctl => {
                if let Some(message) = inner.data.as_ref().and_then(CtlMessage::parse) {
                    self.ctl.notify(&message);
                }
            }
        }
    }
}
