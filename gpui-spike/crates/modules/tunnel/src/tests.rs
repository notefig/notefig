//! Ports of the TS tunnel suites:
//! - `shared/src/tunnel/pairing.test.ts`, `tunnel-protocol.test.ts`
//! - `agents/tunnel/__tests__/tunnel-vectors.test.ts`, `connect-flow.test.ts`,
//!   `require-connection.test.ts`, the tunnel-only half of
//!   `tunnel-transport-symmetry.test.ts` and the pipeline half of
//!   `tunnel-lifecycle.test.ts`
//! plus the agent bridge and a real WebSocket against a local worker.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;
use notefig_core::testing::TestExecutor;
use notefig_core::{Executor, ExecutorExt};
use notefig_kv::{KvApi, create_kv};
use notefig_platform::fake::FakePlatform;
use serde_json::json;

use crate::protocol::encoding::*;
use crate::protocol::test_vectors::*;
use crate::protocol::*;
use crate::testing::{FakeWorker, FakeWorkerOptions};
use crate::*;

// ─── pairing.test.ts ────────────────────────────────────────────────────────

#[test]
fn encodes_the_pinned_secret_and_url_to_the_pinned_code() {
    assert_eq!(
        encode_pairing_code(&hex_to_bytes(VECTOR_SECRET_HEX), VECTOR_TUNNEL_URL).unwrap(),
        VECTOR_PAIRING_CODE
    );
}

#[test]
fn round_trips_including_urls_with_port_and_path() {
    let secret = generate_pairing_secret();
    assert_eq!(secret.len(), PAIRING_SECRET_BYTES);
    for url in ["wss://abc-def.trycloudflare.com", "ws://127.0.0.1:8443/tunnel?x=1"] {
        let decoded = decode_pairing_code(&encode_pairing_code(&secret, url).unwrap()).unwrap();
        assert_eq!(decoded.url, url);
        assert_eq!(decoded.secret, secret);
    }
}

#[test]
fn rejects_malformed_codes() {
    assert!(decode_pairing_code("").is_err());
    assert!(decode_pairing_code("nodothere").is_err());
    assert!(decode_pairing_code("abc.").is_err());
    assert!(decode_pairing_code("1thX6.d3NzOi8vYQ").is_err());
    assert!(decode_pairing_code(&format!("O0Il{}", &VECTOR_PAIRING_CODE[4..])).is_err());
}

#[test]
fn rejects_non_websocket_urls_at_encode_time() {
    assert!(encode_pairing_code(&generate_pairing_secret(), "https://example.com").is_err());
}

#[test]
fn builds_fragment_carried_links() {
    let links = pairing_link("CODE", None);
    assert_eq!(links.web, "https://app.notefig.com/pair#CODE");
    assert_eq!(links.deep_link, "notefig://pair#CODE");
}

#[test]
fn honors_an_app_base_url_override_and_trims_a_trailing_slash() {
    assert_eq!(pairing_link("CODE", Some("http://localhost:1420")).web, "http://localhost:1420/pair#CODE");
    assert_eq!(pairing_link("CODE", Some("https://self.host/")).web, "https://self.host/pair#CODE");
}

#[test]
fn base58_and_base64_codecs_round_trip() {
    for bytes in [vec![], vec![0, 0, 1, 2], vec![255; 40]] {
        assert_eq!(base58_to_bytes(&bytes_to_base58(&bytes)).unwrap(), bytes);
        assert_eq!(base64_to_bytes(&bytes_to_base64(&bytes)).unwrap(), bytes);
        assert_eq!(base64_url_to_bytes(&bytes_to_base64_url(&bytes)).unwrap(), bytes);
    }
}

// ─── tunnel-protocol.test.ts + tunnel-vectors.test.ts ──────────────────────

fn session_key() -> Vec<u8> {
    hex_to_bytes(VECTOR_SESSION_KEY_HEX)
}

#[test]
fn derives_the_pinned_frame_key_from_the_pinned_secret() {
    let key = derive_frame_key(&hex_to_bytes(VECTOR_SECRET_HEX)).unwrap();
    assert_eq!(bytes_to_hex(&key), VECTOR_FRAME_KEY_HEX);
}

#[test]
fn derives_the_pinned_session_key_from_frame_key_and_challenge() {
    let key = derive_session_key(&hex_to_bytes(VECTOR_FRAME_KEY_HEX), &hex_to_bytes(VECTOR_CHALLENGE_HEX));
    assert_eq!(bytes_to_hex(&key), VECTOR_SESSION_KEY_HEX);
}

#[test]
fn seals_the_pinned_inner_frame_to_the_pinned_ciphertexts_at_seq_0() {
    let mut browser = FrameCipher::new(&session_key(), TunnelRole::Browser).unwrap();
    let mut worker = FrameCipher::new(&session_key(), TunnelRole::Worker).unwrap();
    assert_eq!(browser.seal(&vector_inner_frame()).payload, VECTOR_BROWSER_SEQ0_PAYLOAD_B64);
    assert_eq!(worker.seal(&vector_inner_frame()).payload, VECTOR_WORKER_SEQ0_PAYLOAD_B64);
}

#[test]
fn opens_the_pinned_ciphertexts_sealed_by_the_ts_peers() {
    let mut worker = FrameCipher::new(&session_key(), TunnelRole::Worker).unwrap();
    let envelope = FrameEnvelope { seq: 0, payload: VECTOR_BROWSER_SEQ0_PAYLOAD_B64.into() };
    assert_eq!(worker.open(&envelope), Some(vector_inner_frame()));
}

fn ctl_inner() -> InnerFrame {
    InnerFrame::ctl(&CtlMessage::Pair { challenge: "x".into() })
}

fn pair() -> (FrameCipher, FrameCipher) {
    (
        FrameCipher::new(&session_key(), TunnelRole::Browser).unwrap(),
        FrameCipher::new(&session_key(), TunnelRole::Worker).unwrap(),
    )
}

#[test]
fn round_trips_frames_in_both_directions() {
    let (mut browser, mut worker) = pair();
    for i in 0..3u64 {
        let to_worker = InnerFrame {
            ch: TunnelChannel::Mcp,
            task_id: Some("t".into()),
            conn_id: Some(i),
            data: Some(json!(format!("b{i}"))),
        };
        assert_eq!(worker.open(&browser.seal(&to_worker)), Some(to_worker));
        let to_browser = InnerFrame {
            ch: TunnelChannel::Mcp,
            task_id: Some("t".into()),
            conn_id: Some(i),
            data: Some(json!(format!("w{i}"))),
        };
        assert_eq!(browser.open(&worker.seal(&to_browser)), Some(to_browser));
    }
}

#[test]
fn rejects_tampered_ciphertext() {
    let (mut browser, mut worker) = pair();
    let mut envelope = browser.seal(&ctl_inner());
    let cut = envelope.payload.len() - 5;
    envelope.payload = format!("{}AAAA=", &envelope.payload[..cut]);
    assert_eq!(worker.open(&envelope), None);
}

#[test]
fn rejects_a_replayed_seq() {
    let (mut browser, mut worker) = pair();
    let envelope = browser.seal(&ctl_inner());
    assert!(worker.open(&envelope).is_some());
    assert!(worker.open(&envelope).is_none());
}

#[test]
fn rejects_a_skipped_seq() {
    let (mut browser, mut worker) = pair();
    browser.seal(&ctl_inner());
    let second = browser.seal(&ctl_inner());
    assert!(worker.open(&second).is_none());
}

#[test]
fn rejects_a_wrong_direction_nonce() {
    let mut browser = FrameCipher::new(&session_key(), TunnelRole::Browser).unwrap();
    let mut other = FrameCipher::new(&session_key(), TunnelRole::Browser).unwrap();
    let envelope = browser.seal(&ctl_inner());
    assert!(other.open(&envelope).is_none());
}

#[test]
fn rejects_a_frame_sealed_under_a_different_key() {
    let mut browser = FrameCipher::new(&session_key(), TunnelRole::Browser).unwrap();
    let mut worker = FrameCipher::new(&[7u8; 32], TunnelRole::Worker).unwrap();
    assert!(worker.open(&browser.seal(&ctl_inner())).is_none());
}

#[test]
fn round_trips_every_ctl_op_through_json() {
    let ops = vec![
        CtlMessage::Pair { challenge: "abc".into() },
        CtlMessage::PairAck {
            worker: WorkerInfo {
                name: "mbp".into(),
                workspace_path: "/Users/x/book".into(),
                harnesses: vec![HarnessAdvert { id: "claude-code".into(), available: true }],
                protocol: 1,
            },
        },
        CtlMessage::StartTask {
            task_id: "t1".into(),
            harness_id: "claude-code".into(),
            cwd: "/Users/x/book".into(),
            extra_env: BTreeMap::from([("OPENCODE_CONFIG".into(), "/tmp/x.json".into())]),
        },
        CtlMessage::TaskStarted { task_id: "t1".into() },
        CtlMessage::TaskSpawnError { task_id: "t1".into(), message: "ENOENT".into() },
        CtlMessage::StopTask { task_id: "t1".into() },
        CtlMessage::TaskExit { task_id: "t1".into(), code: None },
        CtlMessage::TaskDiagnostic { task_id: "t1".into(), line: "warn".into() },
        CtlMessage::McpOpen { task_id: "t1".into() },
        CtlMessage::McpOpened {
            task_id: "t1".into(),
            mcp_server: McpServerSpec {
                name: "metrists".into(),
                command: "/usr/local/bin/node".into(),
                args: vec!["cli.js".into(), "mcp-relay".into(), "--port".into(), "1234".into()],
                env: vec![EnvVar { name: "NOTEFIG_MCP_TOKEN".into(), value: "tok".into() }],
            },
        },
        CtlMessage::McpClose { task_id: "t1".into() },
    ];
    for op in ops {
        let text = serde_json::to_string(&op).unwrap();
        assert_eq!(CtlMessage::parse(&serde_json::from_str(&text).unwrap()), Some(op));
    }
    // The wire names the TS schema uses.
    let wire = serde_json::to_value(CtlMessage::TaskExit { task_id: "t".into(), code: None }).unwrap();
    assert_eq!(wire, json!({ "op": "task-exit", "taskId": "t", "code": null }));
}

#[test]
fn defaults_start_task_extra_env_to_empty() {
    let parsed =
        CtlMessage::parse(&json!({ "op": "start-task", "taskId": "t1", "harnessId": "opencode", "cwd": "/w" }));
    assert!(matches!(parsed, Some(CtlMessage::StartTask { extra_env, .. }) if extra_env.is_empty()));
}

#[test]
fn rejects_unknown_channels_and_malformed_envelopes() {
    assert!(InnerFrame::parse(json!({ "ch": "smtp", "data": 1 })).is_err());
    assert!(TunnelEnvelope::parse(r#"{"v":2,"t":"hello","challenge":"x"}"#).is_err());
    assert!(TunnelEnvelope::parse(r#"{"v":1,"t":"frame","seq":-1,"payload":""}"#).is_err());
    assert!(TunnelEnvelope::parse(r#"{"v":1,"t":"hello","challenge":"x"}"#).is_ok());
}

// ─── connect-flow.test.ts ───────────────────────────────────────────────────

const WORKSPACE: &str = "/remote/book";

struct Rig {
    exec: Rc<TestExecutor>,
    kv: Rc<KvApi>,
    tunnel: Rc<TunnelApi>,
    disposed: Rc<RefCell<Vec<&'static str>>>,
}

fn rig_with(is_web: bool) -> Rig {
    let exec = TestExecutor::new();
    let kv = Rc::new(create_kv(FakePlatform::new().db.clone()));
    let worker = FakeWorker::new(FakeWorkerOptions::default());
    let connection = create_tunnel_connection(exec.clone(), worker.socket_factory());
    let disposed: Rc<RefCell<Vec<&'static str>>> = Rc::default();
    let log = disposed.clone();
    let tunnel = Rc::new(create_tunnel_pairing(
        kv.clone(),
        connection,
        move || {
            log.borrow_mut().push("dispose");
            async {}.boxed_local()
        },
        is_web,
    ));
    Rig { exec, kv, tunnel, disposed }
}

fn rig() -> Rig {
    rig_with(true)
}

impl Rig {
    /// Point the tunnel at a fresh fake worker.
    fn use_worker(&self, options: FakeWorkerOptions) -> FakeWorker {
        let worker = FakeWorker::new(FakeWorkerOptions { workspace_path: WORKSPACE.into(), ..options });
        self.tunnel.connection().set_socket_factory(worker.socket_factory());
        worker
    }

    fn connection(&self) -> &TunnelConnection {
        self.tunnel.connection()
    }

    fn status(&self) -> &'static str {
        match self.connection().state() {
            TunnelConnectionState::Connected { .. } => "connected",
            TunnelConnectionState::Connecting => "connecting",
            TunnelConnectionState::Disconnected { .. } => "disconnected",
        }
    }

    fn connect(&self, worker: &FakeWorker) -> Result<WorkerInfo, TransportError> {
        self.exec.block_on(self.tunnel.connect(&worker.code()))
    }
}

fn named(name: &str) -> FakeWorkerOptions {
    FakeWorkerOptions { worker_name: name.into(), ..Default::default() }
}

#[test]
fn connects_and_persists_the_pairing() {
    let rig = rig();
    let worker = rig.use_worker(named("studio"));
    let info = rig.connect(&worker).unwrap();
    assert_eq!(info.workspace_path, WORKSPACE);
    assert_eq!(info.name, "studio");
    let stored = rig.exec.block_on(rig.tunnel.stored()).unwrap();
    assert_eq!(stored.worker_name, "studio");
    assert_eq!(stored.workspace_path, WORKSPACE);
    assert_eq!(rig.status(), "connected");
}

#[test]
fn does_not_persist_a_pairing_when_the_handshake_fails() {
    let rig = rig();
    rig.use_worker(Default::default());
    let bad = encode_pairing_code(&generate_pairing_secret(), "wss://fake.example").unwrap();
    let error = rig.exec.block_on(rig.tunnel.connect(&bad)).unwrap_err();
    assert_eq!(error.kind, TransportErrorKind::PairingFailed);
    assert!(rig.exec.block_on(rig.tunnel.stored()).is_none());
    assert_eq!(rig.status(), "disconnected");
}

#[test]
fn auto_connects_a_stored_pairing_on_boot() {
    let rig = rig();
    let worker = rig.use_worker(Default::default());
    rig.connect(&worker).unwrap();
    rig.connection().disconnect();
    rig.exec.run_until_parked();
    let rebooted = rig.use_worker(Default::default());
    rebooted.set_secret(worker.secret());
    let info = rig.exec.block_on(rig.tunnel.auto_connect()).unwrap();
    assert_eq!(info.workspace_path, WORKSPACE);
}

#[test]
fn returns_none_when_auto_connect_fails() {
    let rig = rig();
    let worker = rig.use_worker(Default::default());
    rig.connect(&worker).unwrap();
    rig.connection().disconnect();
    rig.exec.run_until_parked();
    rig.use_worker(Default::default()); // a different secret
    assert!(rig.exec.block_on(rig.tunnel.auto_connect()).is_none());
}

#[test]
fn forget_clears_the_stored_pairing() {
    let rig = rig();
    let worker = rig.use_worker(Default::default());
    rig.connect(&worker).unwrap();
    rig.exec.block_on(rig.tunnel.forget()).unwrap();
    assert!(rig.exec.block_on(rig.tunnel.stored()).is_none());
}

#[test]
fn re_pairs_while_already_connected_without_throwing() {
    let rig = rig();
    let first = rig.use_worker(named("first"));
    rig.connect(&first).unwrap();
    assert_eq!(rig.status(), "connected");
    let second = rig.use_worker(named("second"));
    assert_eq!(rig.connect(&second).unwrap().name, "second");
    assert_eq!(rig.status(), "connected");
}

#[test]
fn connects_a_disconnected_window_when_another_writes_a_pairing() {
    let rig = rig();
    let worker = rig.use_worker(Default::default());
    let _watch = rig.tunnel.watch_cross_tab();
    rig.exec.run_until_parked();
    let pairing = json!({ "code": worker.code() });
    rig.exec.block_on(rig.kv.write(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, &pairing)).unwrap();
    rig.exec.run_until_parked();
    assert_eq!(rig.status(), "connected");
}

#[test]
fn ignores_other_keys_and_the_pairing_being_cleared() {
    let rig = rig();
    let worker = rig.use_worker(Default::default());
    let pairing = json!({ "code": worker.code() });
    rig.exec.block_on(rig.kv.write(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, &pairing)).unwrap();
    let _watch = rig.tunnel.watch_cross_tab();
    rig.exec.run_until_parked();
    rig.exec.block_on(rig.kv.write(TUNNEL_KV_NAMESPACE, "something-else", &"x")).unwrap();
    rig.exec.block_on(rig.tunnel.forget()).unwrap();
    rig.exec.run_until_parked();
    assert_eq!(rig.status(), "disconnected");
}

#[test]
fn parses_a_valid_code_out_of_a_fragment_and_rejects_junk() {
    let code = encode_pairing_code(&generate_pairing_secret(), "wss://x.example").unwrap();
    assert_eq!(pairing_code_from_hash(&format!("#{code}")), Some(code.clone()));
    assert_eq!(pairing_code_from_hash(&code), Some(code.clone()));
    assert_eq!(pairing_code_from_hash(""), None);
    assert_eq!(pairing_code_from_hash("#not-a-code"), None);
    assert_eq!(normalize_pairing_code(&code).unwrap(), code);
}

#[test]
fn a_deep_link_opens_the_dialog_prefilled() {
    let rig = rig();
    let code = encode_pairing_code(&generate_pairing_secret(), "wss://x.example").unwrap();
    assert!(!rig.tunnel.dialog().open_from_link("notefig://pair#junk"));
    assert!(rig.tunnel.dialog().open_from_link(&format!("notefig://pair#{code}")));
    assert_eq!(rig.tunnel.dialog().state(), PairDialogState { open: true, prefill_code: Some(code) });
    assert!(rig.tunnel.dialog().had_deep_link_pairing());
    rig.tunnel.dialog().close();
    assert!(!rig.tunnel.dialog().state().open);
}

// ─── require-connection.test.ts ─────────────────────────────────────────────

fn requests(rig: &Rig) -> (Rc<RefCell<u32>>, notefig_core::Subscription) {
    let count = Rc::new(RefCell::new(0));
    let c = count.clone();
    let sub = rig.tunnel.dialog().on_pairing_requested(move || *c.borrow_mut() += 1);
    (count, sub)
}

#[test]
fn ensure_runtime_passes_on_desktop_without_touching_the_tunnel() {
    let rig = rig_with(false);
    let (count, _sub) = requests(&rig);
    assert!(rig.tunnel.ensure_agent_runtime(false));
    assert_eq!(*count.borrow(), 0);
}

#[test]
fn ensure_runtime_passes_on_web_when_connected() {
    let rig = rig();
    let worker = rig.use_worker(Default::default());
    rig.connect(&worker).unwrap();
    let (count, _sub) = requests(&rig);
    assert!(rig.tunnel.ensure_agent_runtime(false));
    assert_eq!(*count.borrow(), 0);
}

#[test]
fn ensure_runtime_blocks_on_web_when_disconnected_and_asks_for_pairing() {
    let rig = rig();
    let (count, _sub) = requests(&rig);
    assert!(!rig.tunnel.ensure_agent_runtime(false));
    assert_eq!(*count.borrow(), 1);
    assert!(rig.tunnel.ensure_agent_runtime(true), "mock harness sessions need no worker");
}

#[test]
fn ensure_runtime_blocks_while_connecting_too() {
    let rig = rig();
    // A socket that never answers holds the connection in "connecting".
    let silent: TunnelSocketFactory = Rc::new(|_| {
        struct Mute;
        impl TunnelSocket for Mute {
            fn send(&self, _: String) {}
            fn close(&self) {}
        }
        let (_tx, rx) = async_channel::unbounded();
        std::mem::forget(_tx);
        (Rc::new(Mute) as Rc<dyn TunnelSocket>, rx)
    });
    rig.connection().set_socket_factory(silent);
    let pending = rig.connection().connect(TunnelPairing { secret: vec![0; 32], url: "ws://x".into() });
    rig.exec.spawn_local(async move {
        let _ = pending.await;
    });
    rig.exec.run_until_parked();
    assert_eq!(rig.status(), "connecting");
    assert!(!rig.tunnel.ensure_agent_runtime(false));
    // …and the handshake budget ends it.
    rig.exec.advance(HANDSHAKE_TIMEOUT);
    assert_eq!(
        rig.connection().state(),
        TunnelConnectionState::Disconnected { error: Some("handshake timed out".into()) }
    );
}

// ─── tunnel-transport-symmetry.test.ts (tunnel-only cases) ─────────────────

fn connected(options: FakeWorkerOptions) -> (Rig, FakeWorker) {
    let rig = rig();
    let worker = rig.use_worker(options);
    rig.connect(&worker).unwrap();
    (rig, worker)
}

fn spec(task: &str, harness: &str) -> TunnelTransportSpec {
    TunnelTransportSpec {
        task_id: task.into(),
        harness_id: harness.into(),
        workspace_path: "/browser/ws".into(),
        extra_env: BTreeMap::new(),
    }
}

#[test]
fn streams_acp_lines_both_ways_and_splits_batched_frames() {
    let (rig, worker) = connected(Default::default());
    let transport = TunnelTransport::new(spec("t1", "claude-code"), rig.connection().clone());
    rig.exec.block_on(transport.start()).unwrap();
    let lines: Rc<RefCell<Vec<String>>> = Rc::default();
    let l = lines.clone();
    let _sub = transport.on_line(move |line| l.borrow_mut().push(line.into()));
    transport.send(r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#);
    rig.exec.run_until_parked();
    assert_eq!(worker.acp_received("t1").unwrap(), vec![r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#]);
    // One frame carrying two lines (the worker coalesces a stdout chunk),
    // and a frame for another task this transport must not see.
    worker.send_acp("t1", "{\"a\":1}\n{\"b\":2}\n");
    worker.send_acp("t2", "{\"c\":3}");
    rig.exec.run_until_parked();
    assert_eq!(*lines.borrow(), vec!["{\"a\":1}", "{\"b\":2}"]);
    assert_eq!(transport.locus(), "remote");
}

#[test]
fn uses_the_worker_path_as_the_agent_cwd() {
    let (rig, _worker) = connected(Default::default());
    let transport = TunnelTransport::new(spec("t1", "claude-code"), rig.connection().clone());
    assert_eq!(transport.agent_cwd().as_deref(), Some(WORKSPACE));
}

#[test]
fn carries_extra_env_onto_the_worker_with_start_task() {
    let (rig, worker) = connected(Default::default());
    let mut s = spec("t1", "opencode");
    s.extra_env.insert("OPENCODE_CONFIG_CONTENT".into(), "{\"x\":1}".into());
    let transport = TunnelTransport::new(s, rig.connection().clone());
    rig.exec.block_on(transport.start()).unwrap();
    let start = worker
        .received_ctl()
        .into_iter()
        .find(|m| matches!(m, CtlMessage::StartTask { .. }))
        .unwrap();
    let CtlMessage::StartTask { extra_env, harness_id, cwd, .. } = start else { unreachable!() };
    assert_eq!(extra_env["OPENCODE_CONFIG_CONTENT"], "{\"x\":1}");
    assert_eq!(harness_id, "opencode");
    assert_eq!(cwd, "/browser/ws");
}

#[test]
fn answers_mcp_request_lines_on_their_connection() {
    let (rig, worker) = connected(Default::default());
    let endpoint = TunnelMcpEndpoint::new("t1", rig.connection().clone());
    rig.exec.block_on(endpoint.start()).unwrap();
    assert_eq!(endpoint.mcp_server().unwrap().args[1], "mcp-relay");
    let _sub = endpoint.on_request(|line, respond| respond(&format!("reply:{line}")));
    let (a, b) = (worker.mcp_connect(), worker.mcp_connect());
    worker.mcp_send("t1", b, "req-b");
    worker.mcp_send("t1", a, "req-a");
    worker.mcp_send("other", a, "not-mine");
    rig.exec.run_until_parked();
    assert_eq!(worker.mcp_received("t1", a), vec!["reply:req-a"]);
    assert_eq!(worker.mcp_received("t1", b), vec!["reply:req-b"]);
    endpoint.close();
    rig.exec.run_until_parked();
    assert!(worker.received_ctl().contains(&CtlMessage::McpClose { task_id: "t1".into() }));
}

#[test]
fn surfaces_worker_spawn_errors() {
    let (rig, _worker) = connected(FakeWorkerOptions {
        spawn_error: Some(("claude-code".into(), "ENOENT".into())),
        ..Default::default()
    });
    let transport = TunnelTransport::new(spec("t1", "claude-code"), rig.connection().clone());
    let error = rig.exec.block_on(transport.start()).unwrap_err();
    assert_eq!(error.kind, TransportErrorKind::SpawnFailed);
    assert_eq!(error.message, "ENOENT");
}

#[test]
fn task_exit_closes_the_transport_with_desktop_semantics() {
    let (rig, worker) = connected(Default::default());
    let closes: Rc<RefCell<Vec<Option<TransportError>>>> = Rc::default();
    let mut transports = Vec::new();
    for task in ["clean", "crashed", "killed"] {
        let t = TunnelTransport::new(spec(task, "claude-code"), rig.connection().clone());
        rig.exec.block_on(t.start()).unwrap();
        let c = closes.clone();
        t.on_close(move |e| c.borrow_mut().push(e.cloned())).detach();
        transports.push(t);
    }
    worker.exit_task("clean", Some(0));
    worker.exit_task("crashed", Some(3));
    worker.exit_task("killed", None);
    rig.exec.run_until_parked();
    let closes = closes.borrow();
    assert_eq!(closes[0], None);
    assert_eq!(closes[1].as_ref().unwrap().message, "agent process exited (code 3)");
    assert_eq!(closes[1].as_ref().unwrap().kind, TransportErrorKind::Closed);
    assert_eq!(closes[2].as_ref().unwrap().message, "agent process was killed");
}

#[test]
fn diagnostics_ride_ctl_and_close_sends_stop_task() {
    let (rig, worker) = connected(Default::default());
    let t = TunnelTransport::new(spec("t1", "claude-code"), rig.connection().clone());
    rig.exec.block_on(t.start()).unwrap();
    let seen: Rc<RefCell<Vec<String>>> = Rc::default();
    let s = seen.clone();
    let _sub = t.on_diagnostic(move |line| s.borrow_mut().push(line.into()));
    worker.emit_diagnostic("t1", "warn: slow");
    rig.exec.run_until_parked();
    assert_eq!(*seen.borrow(), vec!["warn: slow"]);
    t.close();
    t.send("ignored after close");
    rig.exec.run_until_parked();
    assert!(worker.received_ctl().contains(&CtlMessage::StopTask { task_id: "t1".into() }));
    assert!(worker.acp_received("t1").is_none(), "the worker dropped the task");
}

#[test]
fn runs_the_disconnect_pipeline_before_transport_close_listeners() {
    let (rig, worker) = connected(Default::default());
    let t = TunnelTransport::new(spec("t1", "claude-code"), rig.connection().clone());
    rig.exec.block_on(t.start()).unwrap();
    let order = rig.disposed.clone();
    let state_at_close: Rc<RefCell<Option<&'static str>>> = Rc::default();
    let (s, conn) = (state_at_close.clone(), rig.connection().clone());
    t.on_close(move |e| {
        assert_eq!(e.unwrap().kind, TransportErrorKind::PeerDisconnected);
        order.borrow_mut().push("transport-close");
        *s.borrow_mut() = Some(if conn.state().is_disconnected() { "disconnected" } else { "live" });
    })
    .detach();
    worker.drop_connection();
    rig.exec.run_until_parked();
    assert_eq!(*rig.disposed.borrow(), vec!["dispose", "transport-close"]);
    assert_eq!(*state_at_close.borrow(), Some("disconnected"));
    assert_eq!(
        rig.connection().state(),
        TunnelConnectionState::Disconnected { error: Some("the worker connection dropped".into()) }
    );
}

#[test]
fn rejects_a_protocol_version_mismatched_worker() {
    let rig = rig();
    let worker = rig.use_worker(FakeWorkerOptions { protocol: 2, ..Default::default() });
    let error = rig.connect(&worker).unwrap_err();
    assert!(error.message.contains("protocol mismatch"), "{error}");
}

#[test]
fn start_without_a_connection_fails_as_relay_unreachable() {
    let rig = rig();
    let t = TunnelTransport::new(spec("t1", "claude-code"), rig.connection().clone());
    assert_eq!(rig.exec.block_on(t.start()).unwrap_err().kind, TransportErrorKind::RelayUnreachable);
    let e = TunnelMcpEndpoint::new("t1", rig.connection().clone());
    assert_eq!(rig.exec.block_on(e.start()).unwrap_err().kind, TransportErrorKind::RelayUnreachable);
}

// ─── the module ─────────────────────────────────────────────────────────────

#[test]
fn registers_as_core_tunnel_over_kv() {
    use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services};
    use notefig_platform::PlatformService;
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(Services::new().with::<PlatformService>(fake.platform.clone()))
            .modules(vec![ModuleRef::of::<TunnelModule>()]),
    )
    .unwrap();
    let tunnel = core.use_::<TunnelModule>();
    assert!(tunnel.connection().state().is_disconnected());
    assert!(!tunnel.is_web());
    assert!(tunnel.ensure_agent_runtime(false), "the desktop runs agents locally");
}

// ─── agent bridge ───────────────────────────────────────────────────────────

#[test]
fn the_agent_bridge_carries_acp_lines_through_a_transport_factory() {
    use futures::{AsyncBufReadExt, AsyncWriteExt};
    use notefig_agent::process::SpawnSpec;
    let (rig, worker) = connected(Default::default());
    let bridge = agent_bridge::TunnelBridge::new(rig.connection().clone());
    let factory = bridge.factory();
    let open = factory.open(SpawnSpec {
        harness_id: "claude-code".into(),
        task_id: "t1".into(),
        program: "/local/only".into(),
        args: vec![],
        cwd: "/w".into(),
        env: BTreeMap::new(),
    });
    let transport = rig.exec.block_on(async move { open.await.map_err(|e| e.message).unwrap() });
    let start = worker.received_ctl().into_iter().find(|m| matches!(m, CtlMessage::StartTask { .. })).unwrap();
    assert!(matches!(start, CtlMessage::StartTask { ref harness_id, ref cwd, .. } if harness_id == "claude-code" && cwd == "/w"));
    let notefig_agent::process::Transport { reader, mut writer, .. } = transport;
    // Keep the writer: dropping it stops the task.
    let _writer = rig.exec.block_on(async move {
        writer.write_all(b"{\"id\":1}\n{\"id\":2}\n").await.unwrap();
        writer
    });
    rig.exec.run_until_parked();
    assert_eq!(worker.acp_received("t1").unwrap(), vec!["{\"id\":1}", "{\"id\":2}"]);
    worker.send_acp("t1", "{\"result\":true}");
    rig.exec.run_until_parked();
    let line = rig.exec.block_on(async move {
        let mut lines = futures::io::BufReader::new(reader).lines();
        futures::StreamExt::next(&mut lines).await.unwrap().unwrap()
    });
    assert_eq!(line, "{\"result\":true}");
}

// ─── a real WebSocket against a local worker ───────────────────────────────

/// Core's executor over smol, for tests that do real I/O.
struct SmolExecutor(Rc<smol::LocalExecutor<'static>>);

impl Executor for SmolExecutor {
    fn spawn(&self, future: futures::future::LocalBoxFuture<'static, ()>) {
        self.0.spawn(future).detach();
    }
    fn timer(&self, duration: Duration) -> futures::future::LocalBoxFuture<'static, ()> {
        async move {
            smol::Timer::after(duration).await;
        }
        .boxed_local()
    }
    fn run_blocking(
        &self,
        work: Box<dyn FnOnce() -> Box<dyn std::any::Any + Send> + Send>,
    ) -> futures::future::LocalBoxFuture<'static, Box<dyn std::any::Any + Send>> {
        smol::unblock(work).boxed_local()
    }
}

/// A worker on 127.0.0.1 speaking the protocol over a real WebSocket,
/// answering one connection.
fn spawn_local_worker(secret: Vec<u8>) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = tungstenite::accept(stream).unwrap();
        let (mut peer, hello) = testing::WorkerPeer::new(&secret, FakeWorkerOptions::default());
        ws.send(tungstenite::Message::text(hello)).unwrap();
        while let Ok(message) = ws.read() {
            let tungstenite::Message::Text(text) = message else { continue };
            for reply in peer.handle(&text) {
                ws.send(tungstenite::Message::text(reply)).unwrap();
            }
            // Echo every ACP line back, as an adapter answering would.
            let echoed: Vec<String> = peer.tasks.get("t1").map(|l| l.clone()).unwrap_or_default();
            if let Some(line) = echoed.last()
                && peer.tasks["t1"].len() == 1
            {
                let frame = InnerFrame {
                    ch: TunnelChannel::Acp,
                    task_id: Some("t1".into()),
                    conn_id: None,
                    data: Some(format!("echo:{line}").into()),
                };
                let sealed = peer.seal(&frame);
                ws.send(tungstenite::Message::text(sealed)).unwrap();
                peer.tasks.get_mut("t1").unwrap().push(String::new());
            }
        }
    });
    port
}

#[test]
fn pairs_and_runs_a_task_over_a_real_websocket_to_a_local_worker() {
    let secret = generate_pairing_secret().to_vec();
    let port = spawn_local_worker(secret.clone());
    let local = Rc::new(smol::LocalExecutor::new());
    let executor: Rc<dyn Executor> = Rc::new(SmolExecutor(local.clone()));
    let connection = create_tunnel_connection(executor.clone(), websocket_factory(executor));
    let run = async move {
        let info = connection
            .connect(TunnelPairing { secret, url: format!("ws://127.0.0.1:{port}") })
            .await
            .unwrap();
        assert_eq!(info.workspace_path, "/remote/ws");
        let transport = TunnelTransport::new(spec("t1", "claude-code"), connection.clone());
        transport.start().await.unwrap();
        let (tx, rx) = async_channel::unbounded::<String>();
        let _sub = transport.on_line(move |line| {
            let _ = tx.try_send(line.to_string());
        });
        transport.send("{\"hi\":1}");
        let echoed = rx.recv().await.unwrap();
        connection.disconnect();
        echoed
    };
    let echoed = smol::block_on(local.run(async move {
        smol::future::or(run, async {
            smol::Timer::after(Duration::from_secs(10)).await;
            panic!("timed out talking to the local worker");
        })
        .await
    }));
    assert_eq!(echoed, "echo:{\"hi\":1}");
}
