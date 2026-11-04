//! Port of `packages/core/src/create-core.test.ts`.

use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use futures::FutureExt;

use crate::testing::TestExecutor;
use crate::*;

thread_local! {
    static LOG: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn log(entry: impl Into<String>) {
    LOG.with(|l| l.borrow_mut().push(entry.into()));
}

fn take_log() -> Vec<String> {
    LOG.with(|l| std::mem::take(&mut *l.borrow_mut()))
}

fn core_with(modules: Vec<ModuleRef>) -> (Core, Rc<TestExecutor>) {
    take_log();
    let exec = TestExecutor::new();
    let core = Core::new(CreateCoreOptions::new(exec.clone()).modules(modules)).expect("core");
    (core, exec)
}

// --- fixtures --------------------------------------------------------------

struct Kv;
impl Module for Kv {
    const NAME: &'static str = "kv";
    type Api = RefCell<Vec<String>>;
    type Workspace = String;
    fn register(_: &ModuleContext) -> Self::Api {
        log("register kv");
        RefCell::new(vec![])
    }
    fn boot(_: &Rc<Self::Api>, _: &ModuleContext) -> Option<Subscription> {
        log("boot kv");
        Some(Subscription::new(|| log("dispose boot kv")))
    }
    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(
            WorkspacePart::new(|ctx, _| {
                log(format!("create kv {}", ctx.workspace().path));
                Ok(format!("kv@{}", ctx.workspace().key))
            })
            .dispose(|_, ws, _| {
                log(format!("dispose kv {}", ws.path));
                async { Ok(()) }.boxed_local()
            }),
        )
    }
}

struct Files;
impl Module for Files {
    const NAME: &'static str = "files";
    type Api = String;
    type Workspace = String;
    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<Kv>()]
    }
    fn register(ctx: &ModuleContext) -> Self::Api {
        log("register files");
        ctx.use_::<Kv>().borrow_mut().push("files was here".into());
        "files api".into()
    }
    fn boot(_: &Rc<Self::Api>, _: &ModuleContext) -> Option<Subscription> {
        log("boot files");
        Some(Subscription::new(|| log("dispose boot files")))
    }
    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(
            WorkspacePart::new(|ctx, api| {
                let kv = ctx.use_workspace::<Kv>();
                log(format!("create files {} with {kv} and {api}", ctx.workspace().path));
                Ok("files instance".into())
            })
            .needs(vec![ModuleRef::of::<Kv>()])
            .dispose(|_, ws, api| {
                log(format!("dispose files {} {api}", ws.path));
                async { Ok(()) }.boxed_local()
            }),
        )
    }
}

struct Plain;
impl Module for Plain {
    const NAME: &'static str = "plain";
    type Api = ();
    type Workspace = ();
    fn register(_: &ModuleContext) {
        log("register plain");
    }
    fn boot(_: &Rc<()>, _: &ModuleContext) -> Option<Subscription> {
        log("boot plain");
        None
    }
}

// --- createCore --------------------------------------------------------------

#[test]
fn registers_in_dependency_order_and_exposes_apis() {
    let (core, _) = core_with(vec![ModuleRef::of::<Files>(), ModuleRef::of::<Kv>()]);
    assert_eq!(take_log(), vec!["register kv", "register files"]);
    assert_eq!(*core.use_::<Files>(), "files api");
    assert_eq!(core.use_::<Kv>().borrow().as_slice(), ["files was here"]);
}

#[test]
fn boots_in_dependency_order_and_keeps_listed_order_otherwise() {
    let (core, _) = core_with(vec![
        ModuleRef::of::<Plain>(),
        ModuleRef::of::<Files>(),
        ModuleRef::of::<Kv>(),
    ]);
    take_log();
    core.boot();
    assert_eq!(take_log(), vec!["boot plain", "boot kv", "boot files"]);
    assert_eq!(core.module_names(), vec!["plain", "kv", "files"]);
}

#[test]
fn registers_a_needed_module_the_root_did_not_list() {
    let (core, _) = core_with(vec![ModuleRef::of::<Files>()]);
    assert_eq!(core.module_names(), vec!["kv", "files"]);
}

struct Platform;
impl Service for Platform {
    const NAME: &'static str = "platform";
    type Value = dyn Fn() -> &'static str;
}

struct UsesPlatform;
impl Module for UsesPlatform {
    const NAME: &'static str = "uses-platform";
    type Api = &'static str;
    type Workspace = ();
    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<Platform>()]
    }
    fn register(ctx: &ModuleContext) -> &'static str {
        (ctx.service::<Platform>())()
    }
}

#[test]
fn hands_services_to_modules_that_need_them() {
    let exec = TestExecutor::new();
    let platform: Rc<dyn Fn() -> &'static str> = Rc::new(|| "native");
    let core = Core::new(
        CreateCoreOptions::new(exec)
            .services(Services::new().with::<Platform>(platform))
            .modules(vec![ModuleRef::of::<UsesPlatform>()]),
    )
    .unwrap();
    assert_eq!(*core.use_::<UsesPlatform>(), "native");
    assert_eq!((core.service::<Platform>())(), "native");
}

#[test]
fn fails_startup_on_a_missing_service() {
    let exec = TestExecutor::new();
    let err = Core::new(CreateCoreOptions::new(exec).modules(vec![ModuleRef::of::<UsesPlatform>()]))
        .err()
        .unwrap();
    assert_eq!(err.0, "Service \"platform\" is needed but the root did not provide it.");
}

struct CycleA;
struct CycleB;
impl Module for CycleA {
    const NAME: &'static str = "a";
    type Api = ();
    type Workspace = ();
    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<CycleB>()]
    }
    fn register(_: &ModuleContext) {}
}
impl Module for CycleB {
    const NAME: &'static str = "b";
    type Api = ();
    type Workspace = ();
    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<CycleA>()]
    }
    fn register(_: &ModuleContext) {}
}

#[test]
fn fails_startup_on_a_cycle_or_a_duplicate() {
    let exec = TestExecutor::new();
    let err = Core::new(CreateCoreOptions::new(exec.clone()).modules(vec![ModuleRef::of::<CycleA>()]))
        .err()
        .unwrap();
    assert_eq!(err.0, "Modules need each other in a cycle: a → b → a");
    let err = Core::new(
        CreateCoreOptions::new(exec).modules(vec![ModuleRef::of::<Kv>(), ModuleRef::of::<Kv>()]),
    )
    .err()
    .unwrap();
    assert_eq!(err.0, "Module \"kv\" is registered twice.");
}

struct Sneaky;
impl Module for Sneaky {
    const NAME: &'static str = "sneaky";
    type Api = ();
    type Workspace = ();
    fn register(ctx: &ModuleContext) {
        let _ = ctx.use_::<Kv>();
    }
}

#[test]
fn refuses_a_use_the_module_did_not_declare() {
    let exec = TestExecutor::new();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _ = Core::new(
            CreateCoreOptions::new(exec).modules(vec![ModuleRef::of::<Kv>(), ModuleRef::of::<Sneaky>()]),
        );
    }));
    let panic = result.err().unwrap();
    let msg = panic.downcast_ref::<String>().unwrap();
    assert!(msg.contains("Module \"sneaky\" uses \"kv\" without listing it in needs."), "{msg}");
}

struct FailingBoot;
impl Module for FailingBoot {
    const NAME: &'static str = "failing-boot";
    type Api = ();
    type Workspace = ();
    fn register(_: &ModuleContext) {}
    fn boot(_: &Rc<()>, _: &ModuleContext) -> Option<Subscription> {
        panic!("boot exploded")
    }
}

#[test]
fn isolates_a_failing_boot_and_disposes_boot_work_in_reverse() {
    let exec = TestExecutor::new();
    let errors: Rc<RefCell<Vec<String>>> = Rc::default();
    let sink = errors.clone();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .modules(vec![
                ModuleRef::of::<Kv>(),
                ModuleRef::of::<FailingBoot>(),
                ModuleRef::of::<Files>(),
            ])
            .on_error(move |err, where_| sink.borrow_mut().push(format!("{where_}: {err}"))),
    )
    .unwrap();
    take_log();
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    core.boot();
    std::panic::set_hook(prev);
    assert_eq!(take_log(), vec!["boot kv", "boot files"]);
    assert_eq!(errors.borrow().as_slice(), ["boot of \"failing-boot\": boot exploded"]);
    exec.block_on(core.dispose());
    assert_eq!(take_log(), vec!["dispose boot files", "dispose boot kv"]);
}

struct Ping;
impl Hook for Ping {
    const NAME: &'static str = "test:ping";
    type Payload = u32;
}

#[test]
fn fires_typed_hooks_reporting_a_failing_handler_without_starving_the_rest() {
    let exec = TestExecutor::new();
    let errors: Rc<RefCell<Vec<String>>> = Rc::default();
    let sink = errors.clone();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .on_error(move |err, where_| sink.borrow_mut().push(format!("{where_}: {err}"))),
    )
    .unwrap();
    take_log();
    let _a = core.hooks().on::<Ping, _>(|n| -> anyhow::Result<()> { anyhow::bail!("bad {n}") });
    let _b = core.hooks().on::<Ping, _>(|n| log(format!("b {n}")));
    let n_async = core.hooks().on::<Ping, _>(|n| {
        let n = *n;
        async move {
            log(format!("async {n}"));
            Ok(())
        }
        .boxed_local()
    });
    core.hooks().emit::<Ping>(7);
    exec.run_until_parked();
    assert_eq!(take_log(), vec!["b 7", "async 7"]);
    assert_eq!(errors.borrow().as_slice(), ["hook test:ping: bad 7"]);
    drop(n_async);
    let failures = exec.block_on({
        let hooks = core.hooks().clone();
        async move { hooks.emit_serial::<Ping>(8).await.len() }
    });
    assert_eq!(failures, 1);
    assert_eq!(take_log(), vec!["b 8"]);
}

// --- workspaces ----------------------------------------------------------------

#[test]
fn creates_instances_in_need_order_and_disposes_in_reverse_after_closing() {
    let (core, exec) = core_with(vec![ModuleRef::of::<Files>(), ModuleRef::of::<Kv>()]);
    let _closing = core
        .hooks()
        .on::<WorkspaceClosing, _>(|ws| log(format!("closing {}", ws.path)));
    take_log();
    let ws = core.workspace("/a");
    exec.block_on(ws.open()).unwrap();
    assert_eq!(
        take_log(),
        vec!["create kv /a", "create files /a with kv@/a and files api"]
    );
    assert_eq!(*ws.get::<Files>().unwrap(), "files instance");
    exec.block_on(ws.close());
    assert_eq!(
        take_log(),
        vec!["closing /a", "dispose files /a files api", "dispose kv /a"]
    );
    assert!(ws.get::<Files>().is_err());
}

#[test]
fn collapses_spellings_through_workspace_key_and_keeps_open_idempotent() {
    take_log();
    let exec = TestExecutor::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .modules(vec![ModuleRef::of::<Kv>()])
            .workspace_key(|p| p.trim_end_matches('/').to_lowercase()),
    )
    .unwrap();
    take_log();
    exec.block_on(core.workspace("/A/").open()).unwrap();
    exec.block_on(core.workspace("/a").open()).unwrap();
    assert_eq!(take_log(), vec!["create kv /A/"]);
    assert_eq!(core.workspaces().list().len(), 1);
    assert!(core.workspaces().is_open("/a"));
}

#[test]
fn waits_out_a_running_close_before_reopening() {
    let (core, exec) = core_with(vec![ModuleRef::of::<Kv>()]);
    let _slow = core.hooks().on::<WorkspaceClosing, _>({
        let exec = exec.clone();
        move |_| {
            let timer = crate::Executor::timer(&*exec, Duration::from_millis(10));
            async move {
                timer.await;
                log("slow closing done");
                Ok(())
            }
            .boxed_local()
        }
    });
    let ws = core.workspace("/a");
    exec.block_on(ws.open()).unwrap();
    take_log();
    let close = ws.close();
    let close2 = ws.close();
    let reopened: Rc<RefCell<bool>> = Rc::default();
    let flag = reopened.clone();
    let open = ws.open();
    crate::ExecutorExt::spawn_local(&*exec, async move {
        open.await.unwrap();
        *flag.borrow_mut() = true;
    });
    crate::ExecutorExt::spawn_local(&*exec, async move {
        close.await;
        close2.await;
    });
    exec.run_until_parked();
    assert!(!*reopened.borrow());
    exec.advance(Duration::from_millis(10));
    assert!(*reopened.borrow());
    assert_eq!(take_log(), vec!["slow closing done", "dispose kv /a", "create kv /a"]);
}

struct FailsCreate;
impl Module for FailsCreate {
    const NAME: &'static str = "fails-create";
    type Api = RefCell<u32>;
    type Workspace = ();
    fn needs() -> Vec<ModuleRef> {
        vec![]
    }
    fn register(_: &ModuleContext) -> RefCell<u32> {
        RefCell::new(0)
    }
    fn workspace() -> Option<WorkspacePart<Self>> {
        Some(
            WorkspacePart::new(|_, api: &Rc<RefCell<u32>>| {
                *api.borrow_mut() += 1;
                if *api.borrow() == 1 {
                    anyhow::bail!("first create fails")
                }
                Ok(())
            })
            .needs(vec![ModuleRef::of::<Kv>()]),
        )
    }
}

#[test]
fn never_publishes_a_partial_workspace_and_the_next_open_retries() {
    let exec = TestExecutor::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .modules(vec![ModuleRef::of::<FailsCreate>()])
            .on_error(|_, _| {}),
    )
    .unwrap();
    let entered: Rc<RefCell<u32>> = Rc::default();
    let count = entered.clone();
    let _e = core.hooks().on::<WorkspaceEntered, _>(move |_| *count.borrow_mut() += 1);
    take_log();
    let err = exec.block_on(core.workspace("/a").open()).unwrap_err();
    assert_eq!(err.what, "it did not open");
    assert!(!core.workspaces().is_open("/a"));
    assert_eq!(take_log(), vec!["create kv /a", "dispose kv /a"]);
    assert_eq!(*entered.borrow(), 0);
    exec.block_on(core.workspace("/a").open()).unwrap();
    assert!(core.workspaces().is_open("/a"));
    assert_eq!(*entered.borrow(), 1);
}

#[test]
fn opens_nothing_once_shutdown_has_started_and_closes_open_ones() {
    let (core, exec) = core_with(vec![ModuleRef::of::<Kv>()]);
    exec.block_on(core.workspace("/a").open()).unwrap();
    take_log();
    let dispose = core.dispose();
    exec.block_on(dispose);
    // Never booted, so only the workspace instance goes.
    assert_eq!(take_log(), vec!["dispose kv /a"]);
    exec.block_on(core.workspace("/b").open()).unwrap();
    assert!(!core.workspaces().is_open("/b"));
}

// --- handles -------------------------------------------------------------------

#[test]
fn open_announces_focused_then_entered_focus_only_focused_restore_neither() {
    let (core, exec) = core_with(vec![ModuleRef::of::<Kv>()]);
    let _f = core.hooks().on::<WorkspaceFocused, _>(|ws| log(format!("focused {}", ws.path)));
    let _e = core.hooks().on::<WorkspaceEntered, _>(|ws| log(format!("entered {}", ws.path)));
    let _o = core.hooks().on::<WorkspaceOpened, _>(|ws| log(format!("opened {}", ws.path)));
    take_log();
    exec.block_on(core.workspace("/a").open()).unwrap();
    assert_eq!(take_log(), vec!["create kv /a", "opened /a", "focused /a", "entered /a"]);
    exec.block_on(core.workspace("/a").focus()).unwrap();
    assert_eq!(take_log(), vec!["focused /a"]);
    // A module's restore: the lifecycle opens without announcing an entry.
    struct Restore;
    impl Module for Restore {
        const NAME: &'static str = "restore";
        type Api = WorkspaceLifecycle;
        type Workspace = ();
        fn register(ctx: &ModuleContext) -> WorkspaceLifecycle {
            ctx.workspaces()
        }
    }
    let (core, exec) = core_with(vec![ModuleRef::of::<Kv>(), ModuleRef::of::<Restore>()]);
    let _f = core.hooks().on::<WorkspaceFocused, _>(|ws| log(format!("focused {}", ws.path)));
    let lifecycle = core.use_::<Restore>();
    take_log();
    exec.block_on(async move { lifecycle.open("/r").await });
    assert_eq!(take_log(), vec!["create kv /r"]);
}

#[test]
fn joins_concurrent_opens_one_entry_one_announcement() {
    let (core, exec) = core_with(vec![ModuleRef::of::<Kv>()]);
    let _e = core.hooks().on::<WorkspaceEntered, _>(|ws| log(format!("entered {}", ws.path)));
    take_log();
    let a = core.workspace("/a").open();
    let b = core.workspace("/a").open();
    exec.block_on(async move {
        let (a, b) = futures::join!(a, b);
        a.unwrap();
        b.unwrap();
    });
    assert_eq!(take_log(), vec!["create kv /a", "entered /a"]);
}

#[test]
fn a_failed_focus_handler_stops_the_entry() {
    let exec = TestExecutor::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .modules(vec![ModuleRef::of::<Kv>()])
            .on_error(|_, _| {}),
    )
    .unwrap();
    let _f1 = core
        .hooks()
        .on::<WorkspaceFocused, _>(|_| -> anyhow::Result<()> { anyhow::bail!("no focus") });
    let _f2 = core.hooks().on::<WorkspaceFocused, _>(|_| log("second focus handler"));
    let _e = core.hooks().on::<WorkspaceEntered, _>(|_| log("entered"));
    take_log();
    let err = exec.block_on(core.workspace("/a").open()).unwrap_err();
    assert_eq!(err.what, "focusing it failed");
    assert_eq!(take_log(), vec!["create kv /a", "second focus handler"]);
}

struct Reacher;
impl Module for Reacher {
    const NAME: &'static str = "reacher";
    type Api = ModuleContext;
    type Workspace = ();
    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::of::<Kv>()]
    }
    fn register(ctx: &ModuleContext) -> ModuleContext {
        ctx.clone()
    }
}

#[test]
fn a_module_reaches_another_workspaces_instances_through_its_context() {
    let (core, exec) = core_with(vec![ModuleRef::of::<Reacher>()]);
    exec.block_on(core.workspace("/other").open()).unwrap();
    let ctx = core.use_::<Reacher>();
    assert_eq!(*ctx.workspace_handle("/other").get::<Kv>().unwrap(), "kv@/other");
}
