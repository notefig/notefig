//! Live runs against the installed claude-code harness (costs money; run
//! by hand): `cargo test -p notefig-app --lib live_ -- --ignored --nocapture`.
//! Needs `target/debug/notefig` built (the MCP relay).

use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui::{Entity, TestAppContext, VisualTestContext};
use notefig_agent::host::HostConfig;
use notefig_agent::mcp::RelayCommand;
use notefig_agent::{ChannelServices, JsonFileStore, StartResult};

use crate::agents::Agents;
use crate::agents::chat::ChatItem;
use crate::agents::widget::{PromptWidgetView, WidgetState};
use crate::layout::{OpenMode, Tab};
use crate::tests::{draw, fixture, init, md_source, open, open_file, workspace};
use crate::AppState;

fn wait(cx: &mut VisualTestContext, what: &str, secs: u64, mut done: impl FnMut(&mut VisualTestContext) -> bool) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(secs) {
        draw(cx);
        if done(cx) {
            eprintln!("[live] {what}: {:.1}s", start.elapsed().as_secs_f32());
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out waiting for {what}");
}

fn boot(cx: &mut TestAppContext, state_dir: &std::path::Path) -> Entity<Agents> {
    let (services, requests) = ChannelServices::new();
    let mut config = HostConfig::new(JsonFileStore::new(state_dir.join("agents.json")), services);
    config.probe_catalogs = false;
    let exe = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/notefig");
    config.relay = RelayCommand::app_exe(std::fs::canonicalize(exe).expect("build the notefig binary first"));
    cx.update(|cx| {
        AppState::global(cx).update(cx, |s, _| s.watch_files = true);
        Agents::start(config, requests, cx)
    })
}

#[gpui::test]
#[ignore]
fn live_claude_code_chat_write_and_widget(cx: &mut TestAppContext) {
    cx.executor().allow_parking();
    let f = fixture();
    init(cx, &f.state_path);
    let agents = boot(cx, f.state_path.parent().unwrap());
    let (root, cx) = open(cx, Some(f.ws_path.clone()));
    let ws = workspace(&root, cx);
    let ws_root = f.ws_path.to_string_lossy().into_owned();
    let doc = open_file(&ws, "a.md", cx);
    let handle = agents.read_with(cx, |a, _| a.handle.clone());
    handle.trust(&ws_root);

    // 1. A chat session edits the open file; the editor adopts it; undo reverts.
    let StartResult::Started { task_id } = handle.start_task(&ws_root, "claude-code").recv_blocking().unwrap() else {
        panic!("claude-code did not start")
    };
    cx.update(|window, cx| {
        ws.update(cx, |ws, cx| ws.open_tab(Tab::Chat { task_id: task_id.clone() }, OpenMode::Pinned, window, cx))
    });
    let chat = ws.read_with(cx, |ws, _| ws.chat(&task_id).unwrap());
    let before = md_source(&doc, cx);
    cx.update(|window, cx| {
        chat.update(cx, |c, cx| {
            c.composer.update(cx, |k, cx| {
                k.set_text("In a.md, replace the words 'First note.' with 'Second note.' using your edit tool. Then reply with just: done", cx)
            });
            c.send(window, cx);
        })
    });
    wait(cx, "the editor adopting the agent's edit", 240, |cx| md_source(&doc, cx).contains("Second note."));
    wait(cx, "the turn to settle", 120, |cx| !chat.read_with(cx, |c, _| c.is_busy()));
    let items = chat.read_with(cx, |c, _| c.items.clone());
    eprintln!("[live] transcript items: {}", items.len());
    assert!(items.iter().any(|i| matches!(i, ChatItem::Tool { .. })), "{items:?}");
    let editor = doc.read_with(cx, |d, _| d.markdown_editor().cloned().unwrap());
    cx.update(|_, cx| editor.update(cx, |e, cx| e.undo(cx)));
    draw(cx);
    assert_eq!(md_source(&doc, cx), before, "Cmd+Z reverts the agent write");

    // 2. A `/` prompt widget round answered through widget_respond.
    let doc_b = open_file(&ws, "b.md", cx);
    let editor_b = doc_b.read_with(cx, |d, _| d.markdown_editor().cloned().unwrap());
    cx.update(|window, cx| {
        editor_b.update(cx, |e, cx| {
            let _ = e.select_end(cx);
            e.focus(window, cx);
        })
    });
    cx.simulate_keystrokes("enter");
    cx.simulate_input("/");
    draw(cx);
    let view: Entity<PromptWidgetView> =
        doc_b.read_with(cx, |d, _| d.widgets.as_ref().unwrap().views.borrow().values().next().cloned().unwrap());
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.composer.update(cx, |k, cx| {
                k.set_text("Do not edit any file. Answer with the widget_respond tool, kind answer, markdown: pong", cx)
            });
            v.send(window, cx);
        })
    });
    wait(cx, "the widget round to settle", 240, |cx| {
        matches!(view.read_with(cx, |v, _| v.state), WidgetState::Settled(_) | WidgetState::Asking(_))
    });
    let state = view.read_with(cx, |v, _| v.state);
    let rounds = handle.prompt_rounds();
    let outcome = rounds.iter().find_map(|r| r.outcome.clone());
    eprintln!("[live] widget state {state:?}, outcome {outcome:?}");
    let response = outcome.and_then(|o| o.response).expect("a widget_respond answer");
    assert!(response.markdown.to_lowercase().contains("pong"));
    let _ = handle.shutdown().recv_blocking();
}
