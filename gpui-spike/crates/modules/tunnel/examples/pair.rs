//! Pair with a running `notefig agent` worker and print who answered:
//! `cargo run -p notefig-tunnel --example pair -- <pairing code>`.
//! Interop check against the TS CLI's real worker (loopback only).

use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::Executor;
use notefig_tunnel::protocol::decode_pairing_code;
use notefig_tunnel::{TunnelMcpEndpoint, TunnelPairing, create_tunnel_connection, websocket_factory};

struct SmolExecutor(Rc<smol::LocalExecutor<'static>>);

impl Executor for SmolExecutor {
    fn spawn(&self, future: LocalBoxFuture<'static, ()>) {
        self.0.spawn(future).detach();
    }
    fn timer(&self, duration: Duration) -> LocalBoxFuture<'static, ()> {
        async move {
            smol::Timer::after(duration).await;
        }
        .boxed_local()
    }
    fn run_blocking(
        &self,
        work: Box<dyn FnOnce() -> Box<dyn std::any::Any + Send> + Send>,
    ) -> LocalBoxFuture<'static, Box<dyn std::any::Any + Send>> {
        smol::unblock(work).boxed_local()
    }
}

fn main() {
    let code = std::env::args().nth(1).expect("usage: pair <pairing code>");
    let decoded = decode_pairing_code(&code).expect("a pairing code");
    let local = Rc::new(smol::LocalExecutor::new());
    let executor: Rc<dyn Executor> = Rc::new(SmolExecutor(local.clone()));
    let connection = create_tunnel_connection(executor.clone(), websocket_factory(executor));
    smol::block_on(local.run(async move {
        let info = connection
            .connect(TunnelPairing { secret: decoded.secret, url: decoded.url })
            .await
            .expect("pairing");
        println!("paired: {info:?}");
        let endpoint = TunnelMcpEndpoint::new("interop-task", connection.clone());
        endpoint.start().await.expect("mcp-open");
        println!("mcp-opened: {:?}", endpoint.mcp_server());
        endpoint.close();
        connection.disconnect();
        smol::Timer::after(Duration::from_millis(200)).await;
    }));
}
