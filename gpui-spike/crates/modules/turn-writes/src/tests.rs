//! `turn-writes.test.ts`, over the fake platform's fs and the prompt
//! widgets' test service.

use std::rc::Rc;

use notefig_agents::agent_events::{AgentToolCall, AgentToolCallEvent, AgentTurnSettled, AgentTurnSettledEvent};
use notefig_agent::model::TurnStatus;
use notefig_core::testing::TestExecutor;
use notefig_core::{Executor, Hooks};
use notefig_platform::content_hash;
use notefig_platform::fake::FakePlatform;
use notefig_prompt_widgets::testing::TestPrompts;
use serde_json::{Value, json};

use crate::*;

const DOC: &str = "/ws/notes.md";

fn edit(status: &str, id: &str) -> Value {
    json!({"toolCallId": id, "kind": "edit", "status": status, "locations": [{"path": DOC}]})
}

struct Env {
    exec: Rc<TestExecutor>,
    fake: FakePlatform,
    hooks: Hooks,
    prompts: TestPrompts,
    writes: TurnWritesApi,
}

fn env() -> Env {
    let exec = TestExecutor::new();
    let executor: Rc<dyn Executor> = exec.clone();
    let hooks = Hooks::new(executor.clone(), Rc::new(|err, name| panic!("{name}: {err:#}")));
    let fake = FakePlatform::new();
    let prompts = TestPrompts::new(executor);
    let writes = create_turn_writes(TurnWritesDeps {
        fs: fake.platform.fs.clone(),
        hooks: hooks.clone(),
        prompts: prompts.prompts.clone(),
    });
    let env = Env { exec, fake, hooks, prompts, writes };
    env.widget_watching("blob_1", "trn_1");
    env
}

impl Env {
    /// A widget that sent `turn_id` from DOC, mounted so its document is known.
    fn widget_watching(&self, blob: &str, turn: &str) {
        self.exec.block_on(self.prompts.send(blob, "prompt", "task_1", turn));
        self.prompts.prompts.set_document(blob, DOC);
    }

    fn call(&self, tool_call: Value, turn: &str) {
        let detail = AgentToolCallEvent {
            task_id: "task_1".into(),
            turn_id: turn.into(),
            workspace_path: "/ws".into(),
            tool_call,
        };
        self.exec.block_on(self.writes.record_tool_call(&detail));
    }

    fn blob(&self, path: &str, hash: &str) -> Option<String> {
        self.writes.attribute(path, hash).map(|a| a.blob_id)
    }

    fn turn(&self, path: &str, hash: &str) -> Option<String> {
        self.writes.attribute(path, hash).map(|a| a.turn_id)
    }
}

#[test]
fn credits_a_write_adopted_while_its_edit_is_in_flight_acp_fs_writes() {
    let e = env();
    e.call(edit("in_progress", "tc_1"), "trn_1");
    assert_eq!(
        e.writes.attribute(DOC, "any-hash"),
        Some(PromptChangeAttribution { blob_id: "blob_1".into(), turn_id: "trn_1".into() })
    );
    assert_eq!(e.writes.attribute("/ws/other.md", "any-hash"), None);
}

#[test]
fn credits_the_exact_bytes_a_settled_edit_left_adopted_later_native_writes() {
    let e = env();
    e.fake.fs.seed(DOC, "# written by the agent\n");
    e.call(edit("pending", "tc_1"), "trn_1");
    e.call(edit("completed", "tc_1"), "trn_1");
    assert_eq!(
        e.writes.attribute(DOC, &content_hash("# written by the agent\n")),
        Some(PromptChangeAttribution { blob_id: "blob_1".into(), turn_id: "trn_1".into() })
    );
    // Different bytes are someone else's change.
    assert_eq!(e.writes.attribute(DOC, &content_hash("user edit")), None);
}

#[test]
fn resolves_a_workspace_relative_diff_path() {
    let e = env();
    e.call(
        json!({"toolCallId": "tc_rel", "kind": "edit", "status": "in_progress",
               "content": [{"type": "diff", "path": "./notes.md", "oldText": null, "newText": "x"}]}),
        "trn_1",
    );
    assert_eq!(e.blob(DOC, "h").as_deref(), Some("blob_1"));
}

#[test]
fn prefers_the_round_whose_settled_write_matches_over_a_later_call_in_flight() {
    let e = env();
    e.widget_watching("blob_2", "trn_2");
    e.fake.fs.seed(DOC, "round one");
    e.call(edit("in_progress", "tc_2"), "trn_2");
    e.call(edit("completed", "tc_1"), "trn_1");
    assert_eq!(e.turn(DOC, &content_hash("round one")).as_deref(), Some("trn_1"));
    assert_eq!(e.turn(DOC, "other").as_deref(), Some("trn_2"));
}

#[test]
fn credits_a_later_round_that_writes_an_earlier_rounds_bytes_back() {
    let e = env();
    e.widget_watching("blob_2", "trn_2");
    e.fake.fs.seed(DOC, "same bytes");
    e.call(edit("completed", "tc_1"), "trn_1");
    e.call(edit("in_progress", "tc_2"), "trn_2");
    assert_eq!(e.turn(DOC, &content_hash("same bytes")).as_deref(), Some("trn_2"));
}

#[test]
fn closes_the_calls_a_turn_left_open_when_it_settles() {
    let e = env();
    e.fake.fs.seed(DOC, "partial");
    e.call(edit("in_progress", "tc_1"), "trn_1");
    e.exec.block_on(e.writes.record_turn_settled("trn_1"));
    assert_eq!(e.writes.attribute(DOC, "other"), None);
    assert!(e.writes.attribute(DOC, &content_hash("partial")).is_some());
}

#[test]
fn ignores_reads_and_rounds_no_widget_is_watching() {
    let e = env();
    e.call(json!({"toolCallId": "tc_1", "kind": "read", "status": "in_progress", "locations": [{"path": DOC}]}), "trn_1");
    assert_eq!(e.writes.attribute(DOC, "h"), None);

    e.call(edit("in_progress", "tc_chat"), "trn_chat");
    assert_eq!(e.writes.attribute(DOC, "h"), None);

    // The widget moved on to a new turn: the old round's writes are no
    // longer its to show.
    e.call(edit("in_progress", "tc_2"), "trn_1");
    e.prompts.set_turn("trn_1", "task_1", TurnStatus::Completed);
    e.exec.block_on(e.prompts.send("blob_1", "again", "task_1", "trn_2"));
    assert_eq!(e.writes.attribute(DOC, "h"), None);
}

#[test]
fn the_boot_listeners_follow_the_agent_hooks() {
    let e = env();
    let _track = e.writes.track();
    e.fake.fs.seed(DOC, "partial");
    e.hooks.emit::<AgentToolCall>(AgentToolCallEvent {
        task_id: "task_1".into(),
        turn_id: "trn_1".into(),
        workspace_path: "/ws".into(),
        tool_call: edit("in_progress", "tc_1"),
    });
    e.exec.run_until_parked();
    assert_eq!(e.blob(DOC, "h").as_deref(), Some("blob_1"));
    e.hooks.emit::<AgentTurnSettled>(AgentTurnSettledEvent {
        task_id: "task_1".into(),
        turn_id: "trn_1".into(),
        status: TurnStatus::Cancelled,
        at: 1,
    });
    e.exec.run_until_parked();
    assert_eq!(e.writes.attribute(DOC, "h"), None);
    assert!(e.writes.attribute(DOC, &content_hash("partial")).is_some());
}
