//! The real socket: a WebSocket client (`async-tungstenite` over
//! `async-net`, no tokio), the Rust form of TS's `webSocketFactory`.
//! `ws://` is plain TCP (the CLI worker's default `ws://127.0.0.1:<port>`);
//! `wss://` (a `--tunnel-url` relay) goes through the OS TLS stack.
//!
//! The socket runs as one task on core's executor: it connects, reports
//! `Open`, then pumps outgoing text and incoming frames until either side
//! closes, and always ends with `Close` (after `Error` if it failed), the
//! order a browser `WebSocket` fires them in.

use std::rc::Rc;

use async_tungstenite::WebSocketStream;
use async_tungstenite::tungstenite::Message;
use futures::{AsyncRead, AsyncWrite, FutureExt, StreamExt};
use notefig_core::{Executor, ExecutorExt};

use crate::connection::{SocketEvent, TunnelSocket, TunnelSocketFactory};

enum Command {
    Send(String),
    Close,
}

struct WebSocket {
    commands: async_channel::Sender<Command>,
}

impl TunnelSocket for WebSocket {
    fn send(&self, data: String) {
        let _ = self.commands.try_send(Command::Send(data));
    }

    fn close(&self) {
        let _ = self.commands.try_send(Command::Close);
    }
}

/// Opens real WebSockets, run on `executor`.
pub fn websocket_factory(executor: Rc<dyn Executor>) -> TunnelSocketFactory {
    Rc::new(move |url: &str| {
        let (commands_tx, commands) = async_channel::unbounded();
        let (events_tx, events) = async_channel::unbounded();
        let url = url.to_string();
        executor.spawn_local(async move {
            if let Err(error) = run(&url, commands, &events_tx).await {
                log::warn!("[tunnel] socket to {url}: {error:#}");
                let _ = events_tx.try_send(SocketEvent::Error(error.to_string()));
            }
            let _ = events_tx.try_send(SocketEvent::Close);
        });
        (Rc::new(WebSocket { commands: commands_tx }) as Rc<dyn TunnelSocket>, events)
    })
}

async fn run(
    url: &str,
    commands: async_channel::Receiver<Command>,
    events: &async_channel::Sender<SocketEvent>,
) -> anyhow::Result<()> {
    let parsed = url::Url::parse(url)?;
    let host = parsed.host_str().ok_or_else(|| anyhow::anyhow!("no host in {url}"))?.to_string();
    let port = parsed.port_or_known_default().ok_or_else(|| anyhow::anyhow!("no port in {url}"))?;
    let tcp = async_net::TcpStream::connect((host.as_str(), port)).await?;
    match parsed.scheme() {
        "ws" => {
            let (ws, _) = async_tungstenite::client_async(url, tcp).await?;
            pump(ws, commands, events).await
        }
        "wss" => {
            let tls = async_native_tls::connect(host.as_str(), tcp).await?;
            let (ws, _) = async_tungstenite::client_async(url, tls).await?;
            pump(ws, commands, events).await
        }
        other => anyhow::bail!("not a websocket URL scheme: {other}"),
    }
}

async fn pump<S: AsyncRead + AsyncWrite + Unpin>(
    mut ws: WebSocketStream<S>,
    commands: async_channel::Receiver<Command>,
    events: &async_channel::Sender<SocketEvent>,
) -> anyhow::Result<()> {
    let _ = events.try_send(SocketEvent::Open);
    loop {
        futures::select! {
            command = commands.recv().fuse() => match command {
                Ok(Command::Send(text)) => ws.send(Message::Text(text)).await?,
                Ok(Command::Close) | Err(_) => {
                    let _ = ws.close(None).await;
                    return Ok(());
                }
            },
            message = ws.next().fuse() => match message {
                Some(Ok(Message::Text(text))) => {
                    let _ = events.try_send(SocketEvent::Message(text));
                }
                Some(Ok(Message::Binary(bytes))) => {
                    let _ = events.try_send(SocketEvent::Message(String::from_utf8_lossy(&bytes).into_owned()));
                }
                Some(Ok(Message::Close(_))) | None => return Ok(()),
                Some(Ok(_)) => {}
                Some(Err(error)) => return Err(error.into()),
            },
        }
    }
}
