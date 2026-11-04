//! The app MCP server end to end: loopback endpoint + token handshake +
//! the real `notefig-mcp-relay` binary on stdio, as a harness drives it.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::sync::Arc;

use notefig_agent::mcp::{McpEndpoint, McpHost, RelayCommand};
use notefig_agent::rpc::LocalBoxFuture;
use notefig_agent::{ClientServices, DiskServices};
use serde_json::{Value, json};

struct Host(PathBuf);

impl McpHost for Host {
    fn task_id(&self) -> String {
        "task_test".into()
    }
    fn workspace_path(&self) -> PathBuf {
        self.0.clone()
    }
    fn services(&self) -> Arc<dyn ClientServices> {
        Arc::new(DiskServices)
    }
    fn request_permission(&self, _title: String) -> LocalBoxFuture<bool> {
        Box::pin(async { false })
    }
}

#[test]
fn relay_bin_round_trips_mcp_over_the_endpoint() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a.md"), "line1\nline2\n").unwrap();
    let ws = dir.path().to_path_buf();
    let relay = RelayCommand {
        program: PathBuf::from(env!("CARGO_BIN_EXE_notefig-mcp-relay")),
        args: vec![],
    };

    let ex: Rc<smol::LocalExecutor<'static>> = Rc::new(smol::LocalExecutor::new());
    let endpoint =
        smol::block_on(ex.run(McpEndpoint::start(&ex, Rc::new(Host(ws.clone())), &relay))).unwrap();
    let server = endpoint.server.clone();
    assert_eq!(server.name, "notefig");
    assert_eq!(server.args, vec![endpoint.port.to_string()]);

    // Drive the relay from a thread while the executor serves.
    let client = std::thread::spawn(move || {
        let mut child = Command::new(&server.command)
            .args(&server.args)
            .envs(server.env.iter().cloned())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut ask = |msg: Value| -> Value {
            writeln!(stdin, "{msg}").unwrap();
            let mut line = String::new();
            stdout.read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };
        let init = ask(
            json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
        );
        let tools = ask(json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}));
        let list = ask(
            json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "workspace_list_documents", "arguments": {}}}),
        );
        let read = ask(
            json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "workspace_read_document", "arguments": {"path": "a.md", "line": 2, "limit": 1}}}),
        );
        let escape = ask(
            json!({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "workspace_read_document", "arguments": {"path": "../x"}}}),
        );
        let restore = ask(
            json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "history_restore", "arguments": {"path": "a.md", "checkpoint": "abc"}}}),
        );
        let widget = ask(
            json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": "widget_respond", "arguments": {"kind": "single_choice", "markdown": "which?", "options": "[\"a\",\"b\"]"}}}),
        );
        let bad = ask(
            json!({"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "widget_respond", "arguments": {"kind": "answer"}}}),
        );
        let resource = ask(
            json!({"jsonrpc": "2.0", "id": 9, "method": "resources/read", "params": {"uri": "file:///nope"}}),
        );
        let unknown = ask(json!({"jsonrpc": "2.0", "id": 10, "method": "bogus"}));
        drop(stdin);
        let _ = child.wait();
        (
            init, tools, list, read, escape, restore, widget, bad, resource, unknown,
        )
    });
    let results = smol::block_on(ex.run(async {
        loop {
            if client.is_finished() {
                return client.join().unwrap();
            }
            smol::Timer::after(std::time::Duration::from_millis(10)).await;
        }
    }));
    let (init, tools, list, read, escape, restore, widget, bad, resource, unknown) = results;
    assert_eq!(init["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(init["result"]["serverInfo"]["name"], "notefig");
    assert!(
        init["result"]["instructions"]
            .as_str()
            .unwrap()
            .contains("widget_respond")
    );
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 9);
    assert!(
        list["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("a.md")
    );
    assert_eq!(
        read["result"]["content"][0]["text"],
        json!("line2\n").to_string()
    );
    assert_eq!(escape["result"]["isError"], true);
    assert_eq!(
        restore["result"]["content"][0]["text"],
        "permission denied for \"history_restore\""
    );
    // The stringified options were repaired.
    assert_eq!(
        widget["result"]["content"][0]["text"],
        "{\"recorded\":true}"
    );
    assert!(
        bad["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("invalid input for widget_respond: markdown: Required")
    );
    assert_eq!(resource["error"]["code"], -32602);
    assert_eq!(unknown["error"]["code"], -32601);
    drop(endpoint);
}

#[test]
fn endpoint_rejects_a_wrong_token() {
    let ex: Rc<smol::LocalExecutor<'static>> = Rc::new(smol::LocalExecutor::new());
    let relay = RelayCommand {
        program: "relay".into(),
        args: vec!["--mcp-stdio-relay".into()],
    };
    let endpoint = smol::block_on(ex.run(McpEndpoint::start(
        &ex,
        Rc::new(Host("/tmp".into())),
        &relay,
    )))
    .unwrap();
    assert_eq!(
        endpoint.server.args,
        vec!["--mcp-stdio-relay".to_string(), endpoint.port.to_string()]
    );
    let port = endpoint.port;
    let client = std::thread::spawn(move || {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        writeln!(stream, "wrong").unwrap();
        // The server may already have closed the connection over the bad
        // token, so this write can fail with a broken pipe: that's the point.
        let _ = writeln!(
            stream,
            "{}",
            json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        );
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap_or(0)
    });
    let read = smol::block_on(ex.run(async {
        loop {
            if client.is_finished() {
                return client.join().unwrap();
            }
            smol::Timer::after(std::time::Duration::from_millis(10)).await;
        }
    }));
    assert_eq!(read, 0, "no answer without the token");
}
