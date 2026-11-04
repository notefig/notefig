//! Per-project settings in a `metrists.json` at the workspace root: a port
//! of `modules/project-settings/`. The file is the source of truth: read
//! through the platform's fs, cached per workspace, and dropped from the
//! cache when the watcher reports the file changed. It is only created on
//! the first `update`: opening a workspace never dirties the project.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::future::LocalBoxFuture;
use notefig_core::{Executor, ExecutorExt, Listeners, Module, ModuleContext, ModuleRef, Subscription};
use notefig_files::paths::join;
use notefig_files::FilesChanged;
use notefig_platform::{FileSystem, PlatformService};
use serde_json::{Map, Value};

pub const PROJECT_SETTINGS_FILENAME: &str = "metrists.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Direction {
    #[default]
    Ltr,
    Rtl,
}

/// The typed, fully resolved settings consumers work with.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ProjectSettingsValues {
    pub direction: Direction,
}

/// The raw file: `{ workspace?: {...}, settings?: {...}, ...unknown }`.
/// Kept as JSON so unknown keys survive a write.
pub type ProjectSettings = Map<String, Value>;

/// Overlay the raw file onto the defaults.
pub fn resolve_project_settings(raw: &ProjectSettings) -> ProjectSettingsValues {
    let direction = raw
        .get("settings")
        .and_then(|s| s.get("direction"))
        .and_then(|d| d.as_str())
        .map(|d| if d == "rtl" { Direction::Rtl } else { Direction::Ltr })
        .unwrap_or_default();
    ProjectSettingsValues { direction }
}

pub fn project_settings_path(workspace_path: &str) -> String {
    join(workspace_path, PROJECT_SETTINGS_FILENAME)
}

/// `core.projectSettings`.
pub struct ProjectSettingsApi {
    fs: Rc<dyn FileSystem>,
    executor: Rc<dyn Executor>,
    /// The query cache: workspace → parsed file, once read.
    cache: RefCell<HashMap<String, Rc<ProjectSettings>>>,
    loading: RefCell<std::collections::HashSet<String>>,
    changed: Listeners<()>,
}

pub fn create_project_settings(fs: Rc<dyn FileSystem>, executor: Rc<dyn Executor>) -> ProjectSettingsApi {
    ProjectSettingsApi { fs, executor, cache: RefCell::default(), loading: RefCell::default(), changed: Listeners::new() }
}

async fn read_file(fs: Rc<dyn FileSystem>, workspace_path: String) -> ProjectSettings {
    let path = project_settings_path(&workspace_path);
    let result = fs.read_files(vec![path.clone()]).await;
    let Some((_, content)) = result.succeeded.into_iter().next() else { return Map::new() };
    match serde_json::from_str::<Value>(&content) {
        Ok(Value::Object(map)) => map,
        Ok(_) => Map::new(),
        Err(err) => {
            log::error!("[project-settings] Invalid JSON in {path}: {err}");
            Map::new()
        }
    }
}

impl ProjectSettingsApi {
    /// Read and parse the file. Missing or invalid yields `{}`; never fails.
    pub fn read(&self, workspace_path: &str) -> LocalBoxFuture<'static, ProjectSettings> {
        read_file(self.fs.clone(), workspace_path.to_string()).boxed_local()
    }

    /// Merge `patch` (shallow per top-level section) and write the file
    /// back, preserving unknown keys.
    pub fn update(self: &Rc<Self>, workspace_path: &str, patch: ProjectSettings) -> LocalBoxFuture<'static, anyhow::Result<()>> {
        let this = self.clone();
        let ws = workspace_path.to_string();
        async move {
            let mut next = this.read(&ws).await;
            for (section, value) in patch {
                match (next.get_mut(&section), value) {
                    (Some(Value::Object(current)), Value::Object(p)) => current.extend(p),
                    (_, value) => {
                        next.insert(section, value);
                    }
                }
            }
            let content = serde_json::to_string_pretty(&Value::Object(next))? + "\n";
            let result = this.fs.write_files(vec![(project_settings_path(&ws), content)]).await;
            if let Some(f) = result.failed.first() {
                anyhow::bail!("Failed to write project settings: {}", f.message);
            }
            this.invalidate(&ws);
            Ok(())
        }
        .boxed_local()
    }

    /// The resolved settings now (`useProjectSettings`): defaults until the
    /// first read lands; asking starts it.
    pub fn settings(self: &Rc<Self>, workspace_path: &str) -> ProjectSettingsValues {
        if let Some(raw) = self.cache.borrow().get(workspace_path) {
            return resolve_project_settings(raw);
        }
        self.load(workspace_path);
        ProjectSettingsValues::default()
    }

    pub fn is_loading(&self, workspace_path: &str) -> bool {
        !self.cache.borrow().contains_key(workspace_path)
    }

    fn load(self: &Rc<Self>, workspace_path: &str) {
        if !self.loading.borrow_mut().insert(workspace_path.to_string()) {
            return;
        }
        let this = self.clone();
        let ws = workspace_path.to_string();
        self.executor.spawn_local(async move {
            let raw = this.read(&ws).await;
            this.loading.borrow_mut().remove(&ws);
            this.cache.borrow_mut().insert(ws, Rc::new(raw));
            this.changed.emit();
        });
    }

    /// Drop a workspace's cached settings so they are read again.
    pub fn invalidate(self: &Rc<Self>, workspace_path: &str) {
        if self.cache.borrow_mut().remove(workspace_path).is_some() {
            self.load(workspace_path);
        }
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.changed.subscribe(move |_| listener())
    }
}

/// `projectSettingsModule`.
pub struct ProjectSettingsModule;

impl Module for ProjectSettingsModule {
    const NAME: &'static str = "projectSettings";
    type Api = ProjectSettingsApi;
    type Workspace = ();

    fn needs() -> Vec<ModuleRef> {
        vec![ModuleRef::service::<PlatformService>()]
    }

    fn register(ctx: &ModuleContext) -> ProjectSettingsApi {
        create_project_settings(ctx.service::<PlatformService>().fs.clone(), ctx.executor())
    }

    /// An external edit of a workspace's metrists.json drops its cache.
    fn boot(api: &Rc<ProjectSettingsApi>, ctx: &ModuleContext) -> Option<Subscription> {
        let api = api.clone();
        Some(ctx.hooks().on::<FilesChanged, _>(move |e| {
            if e.paths.contains(&project_settings_path(&e.workspace_path)) {
                api.invalidate(&e.workspace_path);
            }
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notefig_core::testing::TestExecutor;
    use notefig_core::{Core, CreateCoreOptions, Services};
    use notefig_files::FilesChangedEvent;
    use notefig_platform::fake::FakePlatform;
    use serde_json::json;

    fn setup() -> (Rc<TestExecutor>, FakePlatform, Rc<ProjectSettingsApi>) {
        let exec = TestExecutor::new();
        let fake = FakePlatform::new();
        let api = Rc::new(create_project_settings(fake.platform.fs.clone(), exec.clone()));
        (exec, fake, api)
    }

    #[test]
    fn path_and_resolution() {
        assert_eq!(project_settings_path("/ws"), "/ws/metrists.json");
        assert_eq!(resolve_project_settings(&Map::new()), ProjectSettingsValues::default());
        let raw = json!({"settings": {"direction": "rtl"}}).as_object().unwrap().clone();
        assert_eq!(resolve_project_settings(&raw).direction, Direction::Rtl);
    }

    #[test]
    fn read_is_empty_for_missing_invalid_or_non_object_and_parses_valid() {
        let (exec, fake, api) = setup();
        assert!(exec.block_on(api.read("/ws")).is_empty());
        fake.fs.seed("/ws/metrists.json", "{not json");
        assert!(exec.block_on(api.read("/ws")).is_empty());
        fake.fs.seed("/ws/metrists.json", "[1]");
        assert!(exec.block_on(api.read("/ws")).is_empty());
        fake.fs.seed("/ws/metrists.json", r#"{"settings":{"direction":"rtl"}}"#);
        assert_eq!(exec.block_on(api.read("/ws"))["settings"]["direction"], "rtl");
    }

    #[test]
    fn update_creates_merges_shallowly_and_keeps_unknown_keys() {
        let (exec, fake, api) = setup();
        exec.block_on(api.update("/ws", json!({"settings": {"direction": "rtl"}}).as_object().unwrap().clone())).unwrap();
        assert_eq!(fake.fs.read("/ws/metrists.json").unwrap(), "{\n  \"settings\": {\n    \"direction\": \"rtl\"\n  }\n}\n");
        fake.fs.seed("/ws/metrists.json", r#"{"custom":1,"workspace":{"name":"A","version":"1"}}"#);
        exec.block_on(api.update("/ws", json!({"workspace": {"name": "B"}}).as_object().unwrap().clone())).unwrap();
        let raw = exec.block_on(api.read("/ws"));
        assert_eq!(raw["custom"], 1);
        assert_eq!(raw["workspace"], json!({"name": "B", "version": "1"}));
    }

    #[test]
    fn the_module_drops_cached_settings_when_the_watcher_reports_the_file() {
        let exec = TestExecutor::new();
        let fake = FakePlatform::new();
        let core = Core::new(
            CreateCoreOptions::new(exec.clone())
                .services(Services::new().with::<PlatformService>(fake.platform.clone()))
                .modules(vec![ModuleRef::of::<ProjectSettingsModule>()]),
        )
        .unwrap();
        core.boot();
        let api = core.use_::<ProjectSettingsModule>();
        api.settings("/ws");
        exec.run_until_parked();
        assert_eq!(api.settings("/ws").direction, Direction::Ltr);
        fake.fs.seed("/ws/metrists.json", r#"{"settings":{"direction":"rtl"}}"#);
        core.hooks().emit::<FilesChanged>(FilesChangedEvent { workspace_path: "/ws".into(), paths: vec!["/ws/other.md".into()] });
        exec.run_until_parked();
        assert_eq!(api.settings("/ws").direction, Direction::Ltr);
        core.hooks().emit::<FilesChanged>(FilesChangedEvent { workspace_path: "/ws".into(), paths: vec!["/ws/metrists.json".into()] });
        exec.run_until_parked();
        assert_eq!(api.settings("/ws").direction, Direction::Rtl);
    }
}
