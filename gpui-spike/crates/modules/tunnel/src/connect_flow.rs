//! Turns a pairing code into a live tunnel to a `notefig agent` worker.
//! A port of `connect-flow.ts`. The tunnel is global, not tied to a
//! workspace. The last pairing persists in KV so a launch reconnects; a
//! worker restart mints a new URL, so a failed reconnect is a non-fatal
//! "re-pair" prompt, never a boot error.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{ExecutorExt, Subscription};
use notefig_kv::KvApi;
use serde::{Deserialize, Serialize};

use crate::connection::{TransportError, TransportErrorKind, TunnelConnection, TunnelPairing};
use crate::pair_dialog::PairDialogStore;
use crate::protocol::{WorkerInfo, decode_pairing_code, encode_pairing_code};

pub const TUNNEL_KV_NAMESPACE: &str = "tunnel";
pub const TUNNEL_PAIRING_KEY: &str = "pairing";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPairing {
    /// The pairing code (base58 secret + base64url URL) — re-derivable.
    pub code: String,
    #[serde(default)]
    pub worker_name: String,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub paired_at: i64,
}

/// A valid pairing code out of a URL fragment (`.../pair#<code>`), or None.
pub fn pairing_code_from_hash(hash: &str) -> Option<String> {
    let code = hash.strip_prefix('#').unwrap_or(hash);
    if code.is_empty() {
        return None;
    }
    decode_pairing_code(code).ok().map(|_| code.to_string())
}

/// Re-normalize a code (round-trips through decode/encode).
pub fn normalize_pairing_code(code: &str) -> Result<String, String> {
    let decoded = decode_pairing_code(code)?;
    encode_pairing_code(&decoded.secret, &decoded.url)
}

type OnDisconnect = Rc<dyn Fn() -> LocalBoxFuture<'static, ()>>;

/// The tunnel pairing — `core.tunnel` (`TunnelPairingApi`).
pub struct TunnelApi {
    kv: Rc<KvApi>,
    connection: TunnelConnection,
    on_disconnect: OnDisconnect,
    disconnect_registered: Cell<bool>,
    disconnect_sub: RefCell<Option<Subscription>>,
    dialog: PairDialogStore,
    /// Whether this root is the web build (the TS `isWeb()`): the desktop
    /// runs agents locally and has no tunnel gate.
    is_web: bool,
}

/// `createTunnelPairing({ kv, connection, onDisconnect })`.
pub fn create_tunnel_pairing(
    kv: Rc<KvApi>,
    connection: TunnelConnection,
    on_disconnect: impl Fn() -> LocalBoxFuture<'static, ()> + 'static,
    is_web: bool,
) -> TunnelApi {
    TunnelApi {
        kv,
        connection,
        on_disconnect: Rc::new(on_disconnect),
        disconnect_registered: Cell::new(false),
        disconnect_sub: RefCell::default(),
        dialog: PairDialogStore::new(),
        is_web,
    }
}

fn decode_error(message: String) -> TransportError {
    TransportError::new(TransportErrorKind::Unknown, message)
}

impl TunnelApi {
    /// The connection: state for the status pill and dialog, and the
    /// channels transports ride.
    pub fn connection(&self) -> &TunnelConnection {
        &self.connection
    }

    /// The "connect a machine" dialog's open state.
    pub fn dialog(&self) -> &PairDialogStore {
        &self.dialog
    }

    pub fn is_web(&self) -> bool {
        self.is_web
    }

    /// Wire tunnel loss to the same teardown a workspace close runs, once.
    fn ensure_disconnect_handler(&self) {
        if self.disconnect_registered.replace(true) {
            return;
        }
        let handler = self.on_disconnect.clone();
        *self.disconnect_sub.borrow_mut() = Some(self.connection.on_disconnect(move || handler()));
    }

    /// Resolves once the tunnel is fully disconnected, closing it if needed.
    fn ensure_disconnected(&self) -> LocalBoxFuture<'static, ()> {
        let connection = self.connection.clone();
        async move {
            if connection.state().is_disconnected() {
                return;
            }
            let (tx, rx) = futures::channel::oneshot::channel::<()>();
            let tx = RefCell::new(Some(tx));
            let watched = connection.clone();
            let sub = connection.subscribe(move || {
                if watched.state().is_disconnected()
                    && let Some(tx) = tx.borrow_mut().take()
                {
                    let _ = tx.send(());
                }
            });
            connection.disconnect();
            let _ = rx.await;
            drop(sub);
        }
        .boxed_local()
    }

    /// Connect with a pairing code; persist it once the handshake succeeds.
    pub fn connect(&self, code: &str) -> LocalBoxFuture<'static, Result<WorkerInfo, TransportError>> {
        self.ensure_disconnect_handler();
        let decoded = decode_pairing_code(code);
        let disconnected = self.ensure_disconnected();
        let connection = self.connection.clone();
        let kv = self.kv.clone();
        let code = code.to_string();
        async move {
            let decoded = decoded.map_err(decode_error)?;
            // Re-pairing on a live tunnel tears the old one down first.
            disconnected.await;
            let worker = connection.connect(TunnelPairing { secret: decoded.secret, url: decoded.url }).await?;
            let pairing = StoredPairing {
                code,
                worker_name: worker.name.clone(),
                workspace_path: worker.workspace_path.clone(),
                paired_at: now_ms(),
            };
            if let Err(err) = kv.write(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, &pairing).await {
                log::warn!("[tunnel] could not store the pairing: {err:#}");
            }
            Ok(worker)
        }
        .boxed_local()
    }

    pub fn stored(&self) -> LocalBoxFuture<'static, Option<StoredPairing>> {
        self.kv.read(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY)
    }

    pub fn forget(&self) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        self.kv.remove(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY)
    }

    /// Reconnect a stored pairing. Non-fatal: None on any failure.
    pub fn auto_connect(self: &Rc<Self>) -> LocalBoxFuture<'static, Option<WorkerInfo>> {
        let this = self.clone();
        async move {
            let pairing = this.stored().await?;
            this.connect(&pairing.code).await.ok()
        }
        .boxed_local()
    }

    pub fn disconnect(&self) {
        self.connection.disconnect();
    }

    /// A pairing written by someone else (another window, the CLI-opened
    /// tab in TS) connects this one while it is disconnected. Subscribes
    /// only once the namespace has hydrated, so the pairing already on disk
    /// doesn't read as a new one.
    pub fn watch_cross_tab(self: &Rc<Self>) -> Subscription {
        let collection = self.kv.collection(TUNNEL_KV_NAMESPACE);
        let cancelled = Rc::new(Cell::new(false));
        let subscription: Rc<RefCell<Option<Subscription>>> = Rc::default();
        let this = Rc::downgrade(self);
        let executor = self.connection.executor();
        {
            let (cancelled, subscription, collection) = (cancelled.clone(), subscription.clone(), collection.clone());
            let executor = executor.clone();
            executor.clone().spawn_local(async move {
                collection.preload().await;
                if cancelled.get() {
                    return;
                }
                let stored_code = {
                    let collection = collection.clone();
                    move || collection.get_as::<StoredPairing>(TUNNEL_PAIRING_KEY).map(|p| p.code)
                };
                let last_seen = RefCell::new(stored_code());
                let sub = collection.subscribe(move || {
                    let code = stored_code();
                    let is_new = code.is_some() && code != *last_seen.borrow();
                    *last_seen.borrow_mut() = code;
                    if !is_new {
                        return;
                    }
                    let Some(this) = this.upgrade() else { return };
                    // Only a disconnected window follows along.
                    if !this.connection.state().is_disconnected() {
                        return;
                    }
                    let connecting = this.auto_connect();
                    executor.spawn_local(async move {
                        connecting.await;
                    });
                });
                *subscription.borrow_mut() = Some(sub);
            });
        }
        Subscription::new(move || {
            cancelled.set(true);
            subscription.borrow_mut().take();
        })
    }

    /// `ensureAgentRuntime`: whether an agent may start now. Always on the
    /// desktop; on the web only with a live tunnel — otherwise the pairing
    /// dialog is asked for (TS: a snackbar whose action opens it) and the
    /// caller bails.
    pub fn ensure_agent_runtime(&self, mock_mode: bool) -> bool {
        if mock_mode || !self.is_web {
            return true;
        }
        if self.connection.state().is_connected() {
            return true;
        }
        self.dialog.request_pairing();
        false
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}
