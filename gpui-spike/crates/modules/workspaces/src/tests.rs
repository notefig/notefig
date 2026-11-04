//! Ports of `workspaces.test.ts`, `workspaces-restore.test.ts` and
//! `workspaces-open-before-hydration.test.ts`.

use std::cell::Cell;
use std::rc::Rc;

use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services};
use notefig_files::FilesModule;
use notefig_platform::PlatformService;
use notefig_platform::fake::FakePlatform;

use crate::{RestoreWorkspacesModule, WorkspacesModule, workspace_of_path_in, OpenWorkspaceRow};

fn core(fake: &FakePlatform, exec: &Rc<TestExecutor>, restore: bool) -> Core {
    let mut modules = vec![ModuleRef::of::<WorkspacesModule>(), ModuleRef::of::<FilesModule>()];
    if restore {
        modules.push(ModuleRef::of::<RestoreWorkspacesModule>());
    }
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(Services::new().with::<PlatformService>(fake.platform.clone()))
            .modules(modules),
    )
    .unwrap();
    core.boot();
    core
}

#[test]
fn focusing_joins_the_open_set_and_reentry_keeps_one_row_brought_to_front() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    fake.fs.seed("/a/x.md", "");
    fake.fs.seed("/b/y.md", "");
    let core = core(&fake, &exec, false);
    let reg = core.use_::<WorkspacesModule>();
    exec.block_on(core.workspace("/a").open()).unwrap();
    exec.block_on(core.workspace("/b").open()).unwrap();
    exec.run_until_parked();
    assert!(reg.is_open("/a") && reg.is_open("/b"));
    assert_eq!(reg.focused().as_deref(), Some("/b"));
    exec.block_on(core.workspace("/a").focus()).unwrap();
    exec.run_until_parked();
    assert_eq!(reg.open_workspaces().len(), 2);
    assert_eq!(reg.focused().as_deref(), Some("/a"));
    assert!(core.workspace("/a").get::<FilesModule>().is_ok());
}

#[test]
fn closing_drops_the_row_and_tears_down_instances() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    fake.fs.seed("/a/x.md", "");
    let core = core(&fake, &exec, false);
    let reg = core.use_::<WorkspacesModule>();
    exec.block_on(core.workspace("/a").open()).unwrap();
    exec.run_until_parked();
    exec.block_on(core.workspace("/a").close());
    exec.run_until_parked();
    assert!(!reg.is_open("/a"));
    assert!(core.workspace("/a").get::<FilesModule>().is_err());
    assert!(fake.db.snapshot("open-workspaces").is_empty());
    // A no-op for a workspace that is not open.
    exec.block_on(core.workspace("/nope").close());
}

#[test]
fn a_restart_restores_every_persisted_workspace_with_focus_kept() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    fake.fs.seed("/a/x.md", "");
    fake.fs.seed("/b/y.md", "");
    {
        let core = core(&fake, &exec, true);
        exec.block_on(core.workspace("/b").open()).unwrap();
        exec.block_on(core.workspace("/a").open()).unwrap();
        exec.run_until_parked();
    }
    // A new launch over the same db.
    let core = core(&fake, &exec, true);
    let reg = core.use_::<WorkspacesModule>();
    exec.block_on(reg.when_ready());
    exec.run_until_parked();
    assert!(core.workspaces().is_open("/a") && core.workspaces().is_open("/b"));
    assert_eq!(reg.focused().as_deref(), Some("/a"));
    let files = core.workspace("/b").get::<FilesModule>().unwrap();
    assert!(files.metadata().contains("/b/y.md"));
}

#[test]
fn an_open_issued_before_hydration_is_durable() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    fake.fs.seed("/a/x.md", "");
    {
        let core = core(&fake, &exec, false);
        exec.block_on(core.workspace("/a").open()).unwrap();
        exec.run_until_parked();
    }
    assert_eq!(fake.db.snapshot("open-workspaces").len(), 1);
}

#[test]
fn workspace_of_uses_tree_membership_and_the_deepest_match() {
    let row = |p: &str| OpenWorkspaceRow { key: p.into(), path: p.into(), opened_at: 0, focused_at: 0 };
    let rows = vec![row("/ws"), row("/ws/inner")];
    assert_eq!(workspace_of_path_in(&rows, "/ws/a.md").as_deref(), Some("/ws"));
    assert_eq!(workspace_of_path_in(&rows, "/ws/inner/b.md").as_deref(), Some("/ws/inner"));
    assert_eq!(workspace_of_path_in(&rows, "/ws-backup/a.md"), None);
    let _ = Cell::new(0);
}
