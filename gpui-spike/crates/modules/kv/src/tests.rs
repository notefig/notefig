//! Port of `modules/kv/kv.test.ts`, over the fake platform's db.

use std::cell::RefCell;
use std::rc::Rc;

use notefig_core::testing::TestExecutor;
use notefig_core::{Core, CreateCoreOptions, ModuleRef, Services};
use notefig_platform::PlatformService;
use notefig_platform::fake::FakePlatform;

use crate::{KvModule, create_kv};

#[test]
fn writes_then_reads_back_and_persists_under_the_namespace_table() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let kv = create_kv(fake.db.clone());
    exec.block_on(kv.write("settings", "theme", &"dark")).unwrap();
    assert_eq!(exec.block_on(kv.read::<String>("settings", "theme")), Some("dark".into()));
    assert_eq!(fake.db.snapshot("kv:settings")["theme"], serde_json::json!("dark"));
}

#[test]
fn hydrates_what_a_previous_session_wrote() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    exec.block_on(create_kv(fake.db.clone()).write("ns", "a", &1)).unwrap();
    // A fresh store over the same db: a new launch.
    let kv = create_kv(fake.db.clone());
    let rows = kv.collection("ns");
    assert!(!rows.is_hydrated());
    assert_eq!(exec.block_on(kv.read_all::<i32>("ns"))["a"], 1);
    assert!(rows.is_hydrated());
}

#[test]
fn notifies_subscribers_on_hydration_write_and_removal() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let kv = create_kv(fake.db.clone());
    let rows = kv.collection("ns");
    let count = Rc::new(RefCell::new(0));
    let c = count.clone();
    let _sub = rows.subscribe(move || *c.borrow_mut() += 1);
    exec.block_on(kv.write("ns", "k", &true)).unwrap();
    assert_eq!(*count.borrow(), 2, "hydration, then the write");
    exec.block_on(kv.remove("ns", "k")).unwrap();
    exec.block_on(kv.remove("ns", "k")).unwrap();
    assert_eq!(*count.borrow(), 3, "a removal of nothing is silent");
    assert!(fake.db.snapshot("kv:ns").is_empty());
}

#[test]
fn registers_as_a_module_over_the_platform_service() {
    let exec = TestExecutor::new();
    let fake = FakePlatform::new();
    let core = Core::new(
        CreateCoreOptions::new(exec.clone())
            .services(Services::new().with::<PlatformService>(fake.platform.clone()))
            .modules(vec![ModuleRef::of::<KvModule>()]),
    )
    .unwrap();
    let kv = core.use_::<KvModule>();
    exec.block_on(kv.write("x", "y", &"z")).unwrap();
    assert_eq!(fake.db.snapshot("kv:x")["y"], serde_json::json!("z"));
}
