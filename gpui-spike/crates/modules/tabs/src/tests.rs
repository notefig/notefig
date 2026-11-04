//! Ports of `modules/tabs/{tab-id,tab-controllers,tab-handle,tabs,tabs-module}.test.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use futures::FutureExt;
use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services};
use notefig_layout::{LayoutNode, MemoryUrl, PanelNode, SearchParams, UrlService, UrlState, serialize_layout};
use notefig_platform::PlatformService;
use notefig_platform::fake::FakePlatform;

use crate::*;

/// A controller that records what happens to it.
struct Recorder {
    id: String,
    log: Rc<RefCell<Vec<String>>>,
    focusable: bool,
}

impl TabController for Recorder {
    fn tab_id(&self) -> &str {
        &self.id
    }
    fn kind(&self) -> TabKind {
        tab_kind(&self.id)
    }
    fn focus(&self, steal: bool) -> bool {
        self.log.borrow_mut().push(format!("focus {} steal={steal}", self.id));
        self.focusable || steal
    }
    fn is_focusable(&self) -> bool {
        self.focusable
    }
    fn selected_text(&self) -> Option<String> {
        Some(format!("sel {}", self.id))
    }
    fn dispose(&self) {
        self.log.borrow_mut().push(format!("dispose {}", self.id));
    }
}

fn win(id: &str, children: &[&str]) -> LayoutNode {
    LayoutNode::window(id, children, children[0])
}

struct Setup {
    exec: Rc<TestExecutor>,
    url: Rc<MemoryUrl>,
    core: Core,
    log: Rc<RefCell<Vec<String>>>,
}

fn setup(layout: Vec<LayoutNode>, extra: &str) -> Setup {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let mut params = SearchParams::parse(extra);
    if !layout.is_empty() {
        params.set("layout", serialize_layout(&layout));
    }
    let url = MemoryUrl::new(&params.to_search());
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(Services::new().with::<PlatformService>(fake.platform.clone()).with::<UrlService>(url.clone() as Rc<dyn UrlState>))
            .modules(vec![ModuleRef::of::<TabsModule>()]),
    )
    .unwrap();
    core.boot();
    let log = Rc::new(RefCell::new(Vec::new()));
    Setup { exec, url, core, log }
}

impl Setup {
    fn tabs(&self) -> Rc<TabsApi> {
        self.core.use_::<TabsModule>()
    }
    fn mount(&self, id: &str) {
        self.tabs().controllers().register(Rc::new(Recorder { id: id.into(), log: self.log.clone(), focusable: true }));
    }
    fn ids(&self) -> Vec<String> {
        self.tabs().layout().open_tab_ids()
    }
    fn disposed(&self) -> Vec<String> {
        self.log.borrow().iter().filter_map(|l| l.strip_prefix("dispose ").map(str::to_string)).collect()
    }
}

#[test]
fn agent_tab_ids_round_trip_and_files_are_not_agents() {
    assert_eq!(agent_task_id_from_tab_id(&agent_tab_id("task_1")), Some("task_1"));
    assert_eq!(agent_task_id_from_tab_id("/ws/a.md"), None);
    assert_eq!(tab_kind(RELEASE_NOTES_TAB_ID), TabKind::ReleaseNotes);
    assert_eq!(file_tab_path(Some("agent:x")), None);
}

#[test]
fn opens_into_the_active_window_replacing_and_disposing_its_selected_tab() {
    let s = setup(vec![win("w1", &["/a.md"]), win("w2", &["/b.md"])], "");
    s.mount("/a.md");
    assert!(s.tabs().open("/c.md", Default::default()));
    assert_eq!(s.ids(), ["/c.md", "/b.md"]);
    assert_eq!(s.disposed(), ["/a.md"]);
    assert_eq!(s.tabs().active_tab_id().as_deref(), Some("/c.md"));
}

#[test]
fn refuses_a_file_the_editor_cannot_open_but_not_other_kinds() {
    let s = setup(vec![win("w1", &["/a.md"])], "");
    assert!(!s.tabs().open("/blob.bin", Default::default()));
    assert_eq!(s.ids(), ["/a.md"]);
    s.tabs().open_agent("task_1");
    assert_eq!(s.ids(), ["/a.md", "agent:task_1"]);
    assert!(s.disposed().is_empty());
}

#[test]
fn grants_the_focus_handoff_only_for_a_tab_that_opened() {
    let s = setup(vec![win("w1", &["/a.md"])], "");
    s.tabs().open("/blob.bin", OpenTabOptions { handoff: true, ..Default::default() });
    assert!(!s.tabs().controllers().has_handoff("/blob.bin"));
    s.tabs().open("/new.md", OpenTabOptions { handoff: true, ..Default::default() });
    assert!(s.tabs().controllers().has_handoff("/new.md"));
}

#[test]
fn follows_focus_the_window_that_last_held_it_is_active() {
    let s = setup(vec![win("w1", &["/a.md"]), win("w2", &["/b.md"])], "");
    let calls = Rc::new(RefCell::new(0));
    let c = calls.clone();
    let _sub = s.tabs().subscribe(move || *c.borrow_mut() += 1);
    assert_eq!(s.tabs().active_tab_id().as_deref(), Some("/a.md"));
    s.tabs().focused_window().set("w2");
    assert!(*calls.borrow() > 0);
    assert_eq!(s.tabs().active_window_id().as_deref(), Some("w2"));
    assert_eq!(s.tabs().active_tab_id().as_deref(), Some("/b.md"));
}

#[test]
fn selects_closes_and_renames_without_disposing_what_stays() {
    let s = setup(vec![win("w1", &["/a.md", "/b.md"])], "");
    s.mount("/a.md");
    s.mount("/b.md");
    s.tabs().select("/b.md");
    assert_eq!(s.tabs().active_tab_id().as_deref(), Some("/b.md"));
    s.tabs().rename("/b.md", "/b2.md");
    assert_eq!(s.ids(), ["/a.md", "/b2.md"]);
    assert!(s.disposed().is_empty());
    s.tabs().close("/a.md");
    assert_eq!(s.ids(), ["/b2.md"]);
    assert_eq!(s.disposed(), ["/a.md"]);
}

#[test]
fn takes_a_layout_from_the_dock_disposing_the_tabs_it_dropped() {
    let s = setup(vec![win("w1", &["/a.md", "/b.md"])], "");
    s.mount("/a.md");
    s.tabs().apply_layout(vec![win("w1", &["/b.md"])]);
    assert_eq!(s.ids(), ["/b.md"]);
    assert_eq!(s.disposed(), ["/a.md"]);
}

#[test]
fn focuses_now_by_default_or_files_an_intent_that_waits_for_the_mount() {
    let s = setup(vec![win("w1", &["/a.md"])], "");
    assert!(!s.tabs().focus("/a.md", Default::default()), "nothing mounted");
    s.tabs().focus("/a.md", TabFocusRequest { when: Some(FocusTiming::WhenMounted), steal: false });
    s.mount("/a.md");
    assert_eq!(*s.log.borrow(), ["focus /a.md steal=false"]);
    assert!(s.tabs().focus("/a.md", Default::default()));
}

#[test]
fn a_granted_handoff_lets_the_next_claim_steal_and_is_consumed() {
    let controllers = TabControllers::default();
    let log = Rc::new(RefCell::new(Vec::new()));
    controllers.register(Rc::new(Recorder { id: "/a.md".into(), log: log.clone(), focusable: false }));
    assert!(!controllers.focus_tab("/a.md"), "an ambient claim never steals");
    controllers.grant_focus_handoff("/a.md");
    assert!(controllers.focus_tab("/a.md"));
    assert!(!controllers.has_handoff("/a.md"), "consumed");
    controllers.grant_focus_handoff("/a.md");
    controllers.dispose_tab("/a.md");
    assert!(!controllers.has_handoff("/a.md"), "a grant dies with its tab");
}

#[test]
fn controllers_dispatch_no_op_and_dispose_once() {
    let controllers = TabControllers::default();
    let log = Rc::new(RefCell::new(Vec::new()));
    assert_eq!(controllers.selected_text("/x"), None);
    controllers.register(Rc::new(Recorder { id: "/x".into(), log: log.clone(), focusable: true }));
    assert_eq!(controllers.selected_text("/x").as_deref(), Some("sel /x"));
    controllers.dispose_tab("/x");
    controllers.dispose_tab("/x");
    assert_eq!(*log.borrow(), ["dispose /x"]);
    assert!(!controllers.has("/x"));
}

#[test]
fn tab_handle_carries_each_kinds_half_and_is_inert_unmounted() {
    let s = setup(vec![], "");
    let file = s.tabs().tab("/ws/a.md");
    assert!(matches!(&file.kind, TabHandleKind::File { path, .. } if path == "/ws/a.md"));
    assert!(!file.is_mounted() && !file.focus() && file.selected_text().is_none());
    assert!(matches!(s.tabs().tab("agent:t").kind, TabHandleKind::Agent { ref task_id } if task_id == "t"));
}

fn split() -> Vec<LayoutNode> {
    vec![LayoutNode::Panel(PanelNode {
        id: "root".into(),
        orientation: None,
        size: None,
        children: vec![win("left", &["/ws/a.md"]), win("right", &["agent:t1"])],
    })]
}

#[test]
fn the_window_in_front_follows_open_and_select() {
    let s = setup(split(), "");
    s.tabs().focused_window().set("left");
    assert_eq!(s.tabs().active_tab_id().as_deref(), Some("/ws/a.md"));
    s.tabs().open_agent("t1");
    assert_eq!(s.tabs().active_window_id().as_deref(), Some("right"));
    s.tabs().select("/ws/a.md");
    assert_eq!(s.tabs().active_window_id().as_deref(), Some("left"));
}

#[test]
fn focus_window_steps_and_moves_by_direction() {
    let s = setup(split(), "");
    let fw = s.tabs().focused_window().clone();
    fw.set("left");
    let r = |l, t, rr, b| WindowRect { left: l, top: t, right: rr, bottom: b };
    fw.set_rects(vec![("left".into(), r(0., 0., 100., 100.)), ("right".into(), r(104., 0., 200., 100.))]);
    s.tabs().focus_window(WindowStep::Next);
    assert_eq!(fw.get().as_deref(), Some("right"));
    s.tabs().focus_window(WindowStep::Next);
    assert_eq!(fw.get().as_deref(), Some("left"), "wraps");
    s.tabs().focus_window(WindowStep::Down);
    assert_eq!(fw.get().as_deref(), Some("left"), "nothing below: never sideways");
    s.tabs().focus_window(WindowStep::Right);
    assert_eq!(fw.get().as_deref(), Some("right"));
    // Stacked: down reaches it.
    fw.set("left");
    fw.set_rects(vec![("left".into(), r(0., 0., 100., 100.)), ("right".into(), r(0., 104., 100., 200.))]);
    s.tabs().focus_window(WindowStep::Down);
    assert_eq!(fw.get().as_deref(), Some("right"));
}

#[test]
fn rename_open_file_drains_moves_disposes_and_swaps_in_order() {
    let s = setup(vec![win("w1", &["/ws/old.md"])], "");
    s.mount("/ws/old.md");
    let tabs = s.tabs();
    let log = s.log.clone();
    let l = log.clone();
    let run = tabs.rename_open_file("/ws/old.md", "/ws/new.md", move || {
        l.borrow_mut().push("rename-fs".into());
        async { Ok(()) }.boxed_local()
    });
    assert!(tabs.renaming().contains_key("/ws/old.md"));
    s.exec.block_on(run).unwrap();
    assert_eq!(*log.borrow(), ["rename-fs", "dispose /ws/old.md"]);
    assert_eq!(s.ids(), ["/ws/new.md"]);
    assert!(tabs.renaming().is_empty(), "the guard ends once the layout drops the old id");
    let _ = s.url.search();
}

#[test]
fn rename_open_file_refuses_a_second_rename_and_keeps_the_tab_on_failure() {
    let s = setup(vec![win("w1", &["/ws/old.md"])], "");
    s.mount("/ws/old.md");
    let tabs = s.tabs();
    let (tx, rx) = futures::channel::oneshot::channel::<()>();
    let first = tabs.rename_open_file("/ws/old.md", "/ws/new.md", move || {
        async move {
            let _ = rx.await;
            Err(anyhow::anyhow!("disk full"))
        }
        .boxed_local()
    });
    let second = tabs.rename_open_file("/ws/old.md", "/ws/x.md", || async { Ok(()) }.boxed_local());
    assert!(s.exec.block_on(second).is_err());
    let result = Rc::new(RefCell::new(None));
    let r = result.clone();
    notefig_core::ExecutorExt::spawn_local(&*s.exec, async move { *r.borrow_mut() = Some(first.await.is_err()) });
    s.exec.run_until_parked();
    let _ = tx.send(());
    s.exec.run_until_parked();
    assert_eq!(*result.borrow(), Some(true));
    assert_eq!(s.ids(), ["/ws/old.md"], "the tab is intact");
    assert!(s.disposed().is_empty());
    assert!(tabs.renaming().is_empty());
}
