//! The tunnel ("Connect a machine"): a port of
//! `packages/shared/src/tunnel/*` ([`protocol`]) and
//! `packages/desktop/src/modules/agents/tunnel/*`.
//!
//! | TS | here |
//! |---|---|
//! | `shared/tunnel/{encoding,pairing,tunnel-protocol,test-vectors}.ts` | [`protocol`] |
//! | `tunnel-connection.ts` | [`TunnelConnection`] (+ [`websocket_factory`], the real socket) |
//! | `tunnel-transport.ts` | [`TunnelTransport`] |
//! | `tunnel-mcp-endpoint.ts` | [`TunnelMcpEndpoint`] |
//! | `connect-flow.ts` | [`TunnelApi`] / [`create_tunnel_pairing`] |
//! | `pair-dialog-store.ts` | [`PairDialogStore`] |
//! | `require-connection.ts` | [`TunnelApi::ensure_agent_runtime`] |
//! | `tunnel-module.ts` | [`TunnelModule`] + [`TunnelAutoConnectModule`] |
//! | — | [`agent_bridge`]: a `notefig_agent::process::TransportFactory` over the tunnel |
//!
//! TS boots the auto-connect only in the web build (`isWeb()`); per the
//! "a module takes no options" rule that boot is its own module here,
//! [`TunnelAutoConnectModule`], which a root that wants it lists.

pub mod agent_bridge;
mod connect_flow;
mod connection;
mod mcp_endpoint;
mod pair_dialog;
pub mod protocol;
#[cfg(any(test, feature = "testing"))]
pub mod testing;
mod transport;
mod websocket;

use std::rc::Rc;

pub use connect_flow::{
    StoredPairing, TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, TunnelApi, create_tunnel_pairing,
    normalize_pairing_code, pairing_code_from_hash,
};
pub use connection::{
    HANDSHAKE_TIMEOUT, SocketEvent, TransportError, TransportErrorKind, TunnelConnection, TunnelConnectionState,
    TunnelPairing, TunnelSocket, TunnelSocketFactory, create_tunnel_connection,
};
pub use mcp_endpoint::{McpRespond, OPEN_TIMEOUT, TunnelMcpEndpoint};
pub use pair_dialog::{PairDialogState, PairDialogStore};
pub use protocol::WorkerInfo;
pub use transport::{START_TIMEOUT, TunnelTransport, TunnelTransportSpec};
pub use websocket::websocket_factory;

use futures::FutureExt;
use notefig_core::{ExecutorExt, Module, ModuleContext, ModuleRef, Subscription};
use notefig_kv::KvModule;

/// `tunnelModule` — `core.use_::<TunnelModule>()` is `core.tunnel`.
///
/// Deviation: TS needs `workspaceAgentsModule` to dispose every agent when
/// the socket drops. To keep this crate building while the agents crate
/// moves, the drop pipeline is a hook-free seam instead: whoever owns the
/// agents registers it with `connection().on_disconnect(...)` (the agents
/// module's `dispose_all`). See the crate report.
pub struct TunnelModule;

impl Module for TunnelModule {
    const NAME: &'static str = "tunnel";
    type Api = TunnelApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<KvModule>()]
    }

    fn register(ctx: &ModuleContext) -> TunnelApi {
        let executor = ctx.executor();
        let connection = create_tunnel_connection(executor.clone(), websocket_factory(executor));
        create_tunnel_pairing(ctx.use_::<KvModule>(), connection, || async {}.boxed_local(), false)
    }
}

/// The web root's boot half of `tunnelModule`: reconnect a stored pairing
/// (unless this launch carried a deep-link code) and follow pairings other
/// windows make.
pub struct TunnelAutoConnectModule;

impl Module for TunnelAutoConnectModule {
    const NAME: &'static str = "tunnel-auto-connect";
    type Api = ();
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<TunnelModule>()]
    }

    fn register(_ctx: &ModuleContext) {}

    fn boot(_api: &Rc<()>, ctx: &ModuleContext) -> Option<Subscription> {
        let tunnel: Rc<TunnelApi> = ctx.use_::<TunnelModule>();
        if !tunnel.dialog().had_deep_link_pairing() {
            let connecting = tunnel.auto_connect();
            ctx.executor().spawn_local(async move {
                connecting.await;
            });
        }
        Some(tunnel.watch_cross_tab())
    }
}

#[cfg(test)]
mod tests;
