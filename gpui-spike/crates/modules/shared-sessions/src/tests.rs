//! `shared-sessions.test.ts` over a fake task starter and rows, plus the
//! session reuse the runtime's own suite used to check, over the real
//! runtime (mock harness).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use futures::FutureExt;
use notefig_agent::model::{AgentTaskRow, TaskStatus};
use notefig_core::testing::TestExecutor;

use crate::*;

#[derive(Default)]
struct Fake {
    tasks: RefCell<HashMap<String, AgentTaskRow>>,
    /// Task ids the next starts hand out, with their status.
    next: RefCell<Vec<(String, TaskStatus)>>,
    starts: RefCell<Vec<(String, String)>>,
    counter: RefCell<usize>,
}

fn row(task_id: &str, workspace: &str, status: TaskStatus) -> AgentTaskRow {
    let mut row: AgentTaskRow = serde_json::from_value(serde_json::json!({
        "taskId": task_id, "workspacePath": workspace, "title": "t", "status": "idle",
        "harnessId": "claude-code", "createdAt": 0, "updatedAt": 0,
    }))
    .unwrap();
    row.status = status;
    row
}

struct Env {
    exec: Rc<TestExecutor>,
    fake: Rc<Fake>,
    sessions: SharedSessionsApi,
}

fn env() -> Env {
    let fake = Rc::new(Fake::default());
    let (f1, f2) = (fake.clone(), fake.clone());
    let sessions = create_shared_sessions(SharedSessionsDeps {
        start_task: Rc::new(move |ws, harness| {
            f1.starts.borrow_mut().push((ws.to_string(), harness.to_string()));
            let (task_id, status) = f1.next.borrow_mut().remove(0);
            f1.tasks.borrow_mut().insert(task_id.clone(), row(&task_id, ws, status));
            async move { Ok(StartedTask { task_id, started: futures::future::ready(Ok(())).boxed_local() }) }.boxed_local()
        }),
        task: Rc::new(move |id| f2.tasks.borrow().get(id).cloned()),
    });
    Env { exec: TestExecutor::new(), fake, sessions }
}

impl Env {
    fn id(&self) -> String {
        *self.fake.counter.borrow_mut() += 1;
        format!("task_{}", self.fake.counter.borrow())
    }
    /// The next start hands out a fresh task.
    fn stub_start(&self) -> String {
        let id = self.id();
        self.fake.next.borrow_mut().push((id.clone(), TaskStatus::Idle));
        id
    }
    /// A live row seeded directly, for adopt.
    fn insert_task(&self, ws: &str, status: TaskStatus) -> String {
        let id = self.id();
        self.fake.tasks.borrow_mut().insert(id.clone(), row(&id, ws, status));
        id
    }
    fn set_status(&self, id: &str, status: TaskStatus) {
        self.fake.tasks.borrow_mut().get_mut(id).unwrap().status = status;
    }
    fn get_or_start(&self, ws: &str) -> String {
        self.exec.block_on(self.sessions.get_or_start(ws, "claude-code")).unwrap()
    }
    fn starts(&self) -> usize {
        self.fake.starts.borrow().len()
    }
}

#[test]
fn starts_lazily_once_and_reuses_the_live_session() {
    let e = env();
    let task = e.stub_start();
    assert_eq!(e.get_or_start("/ws"), task);
    assert_eq!(e.get_or_start("/ws"), task);
    assert_eq!(e.starts(), 1);
}

#[test]
fn concurrent_sends_share_one_start() {
    let e = env();
    let task = e.stub_start();
    let (a, b) = (e.sessions.get_or_start("/ws", "claude-code"), e.sessions.get_or_start("/ws", "claude-code"));
    assert_eq!(e.exec.block_on(a).unwrap(), task);
    assert_eq!(e.exec.block_on(b).unwrap(), task);
    assert_eq!(e.starts(), 1);
}

#[test]
fn keeps_workspaces_separate() {
    let e = env();
    let a = e.stub_start();
    let b = e.stub_start();
    assert_eq!(e.get_or_start("/ws-a"), a);
    assert_eq!(e.get_or_start("/ws-b"), b);
}

#[test]
fn restarts_when_the_cached_task_row_is_dead() {
    let e = env();
    let dead = e.stub_start();
    e.get_or_start("/ws");
    e.set_status(&dead, TaskStatus::Error);
    let fresh = e.stub_start();
    assert_eq!(e.get_or_start("/ws"), fresh);
}

#[test]
fn drop_forgets_without_spawning_next_send_starts_fresh() {
    let e = env();
    let first = e.stub_start();
    e.get_or_start("/ws");
    e.sessions.drop_session("/ws");
    assert_eq!(e.sessions.peek("/ws"), None);
    assert_eq!(e.starts(), 1);
    let second = e.stub_start();
    assert_eq!(e.get_or_start("/ws"), second);
    assert_ne!(second, first);
}

#[test]
fn peek_reflects_liveness() {
    let e = env();
    assert_eq!(e.sessions.peek("/ws"), None);
    let task = e.stub_start();
    e.get_or_start("/ws");
    assert_eq!(e.sessions.peek("/ws"), Some(task.clone()));
    e.set_status(&task, TaskStatus::Cancelled);
    assert_eq!(e.sessions.peek("/ws"), None);
}

#[test]
fn adopts_a_live_task_without_starting_a_new_one() {
    let e = env();
    let task = e.insert_task("/ws", TaskStatus::Idle);
    e.sessions.adopt("/ws", &task);
    assert_eq!(e.get_or_start("/ws"), task);
    assert_eq!(e.starts(), 0);
}

#[test]
fn adopt_no_ops_when_the_task_id_is_missing() {
    let e = env();
    e.sessions.adopt("/ws", "task_missing");
    assert_eq!(e.sessions.peek("/ws"), None);
}

#[test]
fn adopt_no_ops_when_the_task_is_errored_or_cancelled() {
    let e = env();
    let errored = e.insert_task("/ws", TaskStatus::Error);
    e.sessions.adopt("/ws", &errored);
    assert_eq!(e.sessions.peek("/ws"), None);
    let cancelled = e.insert_task("/ws", TaskStatus::Cancelled);
    e.sessions.adopt("/ws", &cancelled);
    assert_eq!(e.sessions.peek("/ws"), None);
}

#[test]
fn drop_after_adopting_starts_fresh_on_next_send() {
    let e = env();
    let adopted = e.insert_task("/ws", TaskStatus::Idle);
    e.sessions.adopt("/ws", &adopted);
    e.sessions.drop_session("/ws");
    assert_eq!(e.sessions.peek("/ws"), None);
    let fresh = e.stub_start();
    assert_eq!(e.get_or_start("/ws"), fresh);
}

#[test]
fn adopted_session_going_dead_falls_back_to_starting_fresh() {
    let e = env();
    let adopted = e.insert_task("/ws", TaskStatus::Idle);
    e.sessions.adopt("/ws", &adopted);
    e.set_status(&adopted, TaskStatus::Error);
    assert_eq!(e.sessions.peek("/ws"), None);
    let fresh = e.stub_start();
    assert_eq!(e.get_or_start("/ws"), fresh);
}

/// Was `runtime/tests_fake_agent.rs`'s `shared_session_is_reused_per_workspace`.
#[test]
fn the_module_starts_one_session_per_workspace_through_the_agents_facade() {
    use notefig_core::{Core, CreateCoreOptions, ExecutorExt, ModuleRef, Services};
    use notefig_platform::PlatformService;
    use notefig_platform::fake::FakePlatform;
    // SAFETY: the only test in this binary that sets env.
    unsafe {
        std::env::set_var("NOTEFIG_AGENT_MOCK", "1");
        std::env::remove_var("NOTEFIG_NO_AGENTS");
    }
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(
                Services::new()
                    .with::<PlatformService>(fake.platform.clone())
                    .with::<notefig_layout::UrlService>(notefig_layout::MemoryUrl::new("")),
            )
            .modules(vec![ModuleRef::of::<SharedSessionsModule>()]),
    )
    .unwrap();
    core.boot();
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().canonicalize().unwrap().to_string_lossy().into_owned();
    let wait = |fut: LocalBoxFuture<'static, Result<String, String>>| {
        let slot: Rc<RefCell<Option<Result<String, String>>>> = Rc::default();
        let out = slot.clone();
        exec.spawn_local(async move { *out.borrow_mut() = Some(fut.await) });
        let deadline = Instant::now() + Duration::from_secs(15);
        while slot.borrow().is_none() {
            exec.run_until_parked();
            assert!(Instant::now() < deadline, "timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
        slot.borrow_mut().take().unwrap()
    };
    let sessions = core.use_::<SharedSessionsModule>();
    let a = wait(sessions.get_or_start(&ws, "claude-code")).unwrap();
    let b = wait(sessions.get_or_start(&ws, "claude-code")).unwrap();
    assert_eq!(a, b);
    assert_eq!(sessions.peek(&ws), Some(a.clone()));
    sessions.drop_session(&ws);
    let c = wait(sessions.get_or_start(&ws, "claude-code")).unwrap();
    assert_ne!(a, c);
    assert_eq!(wait(sessions.get_or_start(&ws, "no-such-harness")).ok(), Some(c), "a live session is reused whatever harness is asked");
}
