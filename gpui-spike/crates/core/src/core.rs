//! `createCore`: the kernel (port of `create-core.ts`).

use std::any::TypeId;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::{LocalBoxFuture, Shared};

use crate::context::{ModuleContext, WorkspaceContext, needs_set};
use crate::executor::Executor;
use crate::hooks::{Hook, Hooks, OnError};
use crate::module::{Erased, ErasedModule, Module, ModuleRef, Service, ServiceSlot, Services};
use crate::order::order_modules;
use crate::subscription::{Listeners, Subscription};
use crate::{CoreConfigError, WorkspaceRef};

// ---------------------------------------------------------------------------
// Core's own hooks
// ---------------------------------------------------------------------------

/// Every module has booted.
pub struct CoreBooted;
impl Hook for CoreBooted {
    const NAME: &'static str = "core:booted";
    type Payload = ();
}

/// Core is shutting down; awaited in order before disposers run.
pub struct CoreShutdown;
impl Hook for CoreShutdown {
    const NAME: &'static str = "core:shutdown";
    type Payload = ();
}

/// Every workspace instance for this workspace has been created. Fires for
/// any open, a module's restore included.
pub struct WorkspaceOpened;
impl Hook for WorkspaceOpened {
    const NAME: &'static str = "workspace:opened";
    type Payload = WorkspaceRef;
}

/// Brought to the front through its handle (`open` or `focus`), after it
/// opened if it was not open. Awaited in order before the call resolves.
pub struct WorkspaceFocused;
impl Hook for WorkspaceFocused {
    const NAME: &'static str = "workspace:focused";
    type Payload = WorkspaceRef;
}

/// Entered through its handle's `open`: someone chose this workspace.
/// After `workspace:focused`; awaited in order.
pub struct WorkspaceEntered;
impl Hook for WorkspaceEntered {
    const NAME: &'static str = "workspace:entered";
    type Payload = WorkspaceRef;
}

/// The workspace is closing; awaited in order before its instances go.
pub struct WorkspaceClosing;
impl Hook for WorkspaceClosing {
    const NAME: &'static str = "workspace:closing";
    type Payload = WorkspaceRef;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct WorkspaceClosedError(pub String);

/// A handle's `open` or `focus` that did not complete.
#[derive(Debug, Clone)]
pub struct WorkspaceOpenError {
    pub workspace_path: String,
    pub what: String,
    /// What failed: the module's create error, or each failing handler's.
    pub failures: Vec<Rc<anyhow::Error>>,
}

impl std::fmt::Display for WorkspaceOpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Opening {}: {}.", self.workspace_path, self.what)?;
        for failure in &self.failures {
            write!(f, " {failure:#}")?;
        }
        Ok(())
    }
}

impl std::error::Error for WorkspaceOpenError {}

impl std::fmt::Display for WorkspaceClosedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for WorkspaceClosedError {}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

pub struct CreateCoreOptions {
    /// What the host hands every module: the platform, the executor's
    /// clock, the url state…
    pub services: Services,
    /// In any order; core sorts them by `needs`.
    pub modules: Vec<ModuleRef>,
    pub executor: Rc<dyn Executor>,
    /// Identity of a workspace path: two spellings of one workspace must map
    /// to one key. Defaults to the path.
    pub workspace_key: Option<Rc<dyn Fn(&str) -> String>>,
    /// Where a failing boot, hook handler or dispose is reported.
    pub on_error: Option<OnError>,
}

impl CreateCoreOptions {
    pub fn new(executor: Rc<dyn Executor>) -> Self {
        Self {
            services: Services::new(),
            modules: Vec::new(),
            executor,
            workspace_key: None,
            on_error: None,
        }
    }

    pub fn services(mut self, services: Services) -> Self {
        self.services = services;
        self
    }

    pub fn modules(mut self, modules: Vec<ModuleRef>) -> Self {
        self.modules = modules;
        self
    }

    pub fn workspace_key(mut self, key: impl Fn(&str) -> String + 'static) -> Self {
        self.workspace_key = Some(Rc::new(key));
        self
    }

    pub fn on_error(mut self, on_error: impl Fn(&anyhow::Error, &str) + 'static) -> Self {
        self.on_error = Some(Rc::new(on_error));
        self
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type Done = Shared<LocalBoxFuture<'static, ()>>;
type Joined = Shared<LocalBoxFuture<'static, Result<(), WorkspaceOpenError>>>;

#[derive(Clone)]
pub(crate) struct OpenWorkspace {
    pub(crate) reference: WorkspaceRef,
    pub(crate) instances: Rc<RefCell<HashMap<TypeId, Erased>>>,
}

pub(crate) struct CoreInner {
    pub(crate) apis: RefCell<HashMap<TypeId, Erased>>,
    pub(crate) hooks: Hooks,
    pub(crate) executor: Rc<dyn Executor>,
    on_error: OnError,
    key_of: Rc<dyn Fn(&str) -> String>,
    ordered: Vec<Rc<dyn ErasedModule>>,
    workspace_modules: Vec<Rc<dyn ErasedModule>>,

    shutting_down: Cell<bool>,
    rolling_back: RefCell<HashMap<String, Done>>,
    latest_call: RefCell<HashMap<String, u64>>,
    next_call: Cell<u64>,
    open: RefCell<HashMap<String, OpenWorkspace>>,
    /// Insertion order of `open`, so `list()` is stable.
    open_order: RefCell<Vec<String>>,
    closing: RefCell<HashMap<String, (OpenWorkspace, Done)>>,
    listeners: Listeners<()>,
    entering: RefCell<HashMap<String, Joined>>,
    focusing: RefCell<HashMap<String, Joined>>,
    disposers: RefCell<Vec<Subscription>>,
    booted: Cell<bool>,
    disposed: RefCell<Option<Done>>,
}

enum Opened {
    Open(OpenWorkspace),
    Failed(Rc<anyhow::Error>),
    Skipped,
}

impl CoreInner {
    fn context_for(self: &Rc<Self>, module: &Rc<dyn ErasedModule>) -> ModuleContext {
        ModuleContext {
            module: module.name(),
            needs: needs_set(&module.needs()),
            core: self.clone(),
        }
    }

    fn report(&self, err: &anyhow::Error, where_: &str) {
        (self.on_error)(err, where_);
    }

    fn take_ticket(&self, key: &str) -> u64 {
        let ticket = self.next_call.get() + 1;
        self.next_call.set(ticket);
        self.latest_call.borrow_mut().insert(key.to_string(), ticket);
        ticket
    }

    /// A call is over: forget its ticket unless a later call replaced it.
    fn settle(&self, key: &str, ticket: u64) {
        let mut latest = self.latest_call.borrow_mut();
        if latest.get(key) == Some(&ticket) {
            latest.remove(key);
        }
    }

    fn is_latest(&self, key: &str, ticket: u64) -> bool {
        self.latest_call.borrow().get(key) == Some(&ticket)
    }

    fn notify(&self) {
        self.listeners.emit();
    }

    /// Dispose an entry's instances in reverse need order. Never fails.
    async fn dispose_instances(self: Rc<Self>, entry: OpenWorkspace) {
        for module in self.workspace_modules.iter().rev() {
            let instance = entry.instances.borrow().get(&module.id()).cloned();
            let Some(instance) = instance else { continue };
            let api = self.apis.borrow().get(&module.id()).cloned().expect("registered");
            if let Some(fut) = module.dispose(instance, entry.reference.clone(), api)
                && let Err(err) = fut.await
            {
                self.report(
                    &err,
                    &format!(
                        "workspace dispose of \"{}\" for {}",
                        module.name(),
                        entry.reference.path
                    ),
                );
            }
        }
    }

    /// Every module's instance, or the failure. A partial set is never
    /// published: the ones already built are disposed and the workspace
    /// stays closed, so the next `open` retries from scratch.
    fn create_workspace(self: &Rc<Self>, reference: WorkspaceRef) -> Result<OpenWorkspace, Rc<anyhow::Error>> {
        let instances: Rc<RefCell<HashMap<TypeId, Erased>>> = Rc::default();
        for module in &self.workspace_modules {
            let ctx = WorkspaceContext {
                base: self.context_for(module),
                workspace: reference.clone(),
                workspace_needs: needs_set(&module.workspace_needs()),
                instances: instances.clone(),
            };
            let api = self.apis.borrow().get(&module.id()).cloned().expect("registered");
            match module.create(&ctx, &api) {
                Ok(instance) => {
                    instances.borrow_mut().insert(module.id(), instance);
                }
                Err(err) => {
                    self.report(
                        &err,
                        &format!("workspace create of \"{}\" for {}", module.name(), reference.path),
                    );
                    let entry = OpenWorkspace {
                        reference: reference.clone(),
                        instances: instances.clone(),
                    };
                    let key = reference.key.clone();
                    let this = self.clone();
                    let (tx, rx) = oneshot::channel::<()>();
                    let done: Done = rx.map(|_| ()).boxed_local().shared();
                    self.rolling_back.borrow_mut().insert(key.clone(), done);
                    self.executor.spawn(Box::pin(async move {
                        this.clone().dispose_instances(entry).await;
                        this.rolling_back.borrow_mut().remove(&key);
                        let _ = tx.send(());
                    }));
                    return Err(Rc::new(err));
                }
            }
        }
        Ok(OpenWorkspace {
            reference,
            instances,
        })
    }

    fn pending_for(&self, key: &str) -> Option<Done> {
        self.closing
            .borrow()
            .get(key)
            .map(|(_, done)| done.clone())
            .or_else(|| self.rolling_back.borrow().get(key).cloned())
    }

    async fn open_workspace(self: Rc<Self>, path: String) -> Opened {
        if self.shutting_down.get() {
            return Opened::Skipped;
        }
        let key = (self.key_of)(&path);
        let ticket = self.take_ticket(&key);
        let outcome = async {
            // A close or a failed open's rollback still running: let it
            // finish first, so its disposers never tear down fresh instances.
            while let Some(pending) = self.pending_for(&key) {
                pending.await;
                if self.shutting_down.get() || !self.is_latest(&key, ticket) {
                    return Opened::Skipped;
                }
            }
            if let Some(existing) = self.open.borrow().get(&key).cloned() {
                return Opened::Open(existing);
            }
            let reference = WorkspaceRef {
                key: key.clone(),
                path: path.clone(),
            };
            match self.create_workspace(reference) {
                Err(err) => Opened::Failed(err),
                Ok(created) => {
                    self.open.borrow_mut().insert(key.clone(), created.clone());
                    self.open_order.borrow_mut().push(key.clone());
                    self.notify();
                    self.hooks.emit::<WorkspaceOpened>(created.reference.clone());
                    Opened::Open(created)
                }
            }
        }
        .await;
        self.settle(&key, ticket);
        outcome
    }

    fn close_workspace(self: &Rc<Self>, path: &str) -> Done {
        let key = (self.key_of)(path);
        let ticket = self.take_ticket(&key);
        if let Some((_, done)) = self.closing.borrow().get(&key).cloned() {
            let this = self.clone();
            let k = key.clone();
            let d = done.clone();
            self.executor.spawn(Box::pin(async move {
                d.await;
                this.settle(&k, ticket);
            }));
            return done;
        }
        let entry = self.open.borrow_mut().remove(&key);
        let Some(entry) = entry else {
            self.settle(&key, ticket);
            return futures::future::ready(()).boxed_local().shared();
        };
        self.open_order.borrow_mut().retain(|k| *k != key);
        // Registered before teardown starts: `closing` handlers must still
        // find the instances.
        let (tx, rx) = oneshot::channel::<()>();
        let done: Done = rx.map(|_| ()).boxed_local().shared();
        self.closing
            .borrow_mut()
            .insert(key.clone(), (entry.clone(), done.clone()));
        self.notify();
        let this = self.clone();
        self.executor.spawn(Box::pin(async move {
            this.hooks
                .emit_serial::<WorkspaceClosing>(entry.reference.clone())
                .await;
            this.clone().dispose_instances(entry).await;
            this.closing.borrow_mut().remove(&key);
            this.settle(&key, ticket);
            this.notify();
            let _ = tx.send(());
        }));
        done
    }

    /// Open, then announce, one step after another.
    async fn bring_forward(self: Rc<Self>, path: String, entered: bool) -> Result<(), WorkspaceOpenError> {
        let fail = |what: &str, failures: Vec<Rc<anyhow::Error>>| WorkspaceOpenError {
            workspace_path: path.clone(),
            what: what.to_string(),
            failures,
        };
        let reference = match self.clone().open_workspace(path.clone()).await {
            Opened::Failed(err) => return Err(fail("it did not open", vec![err])),
            // A close superseded the open, or core is shutting down.
            Opened::Skipped => return Ok(()),
            Opened::Open(entry) => entry.reference,
        };
        let unfocused = self.hooks.emit_serial::<WorkspaceFocused>(reference.clone()).await;
        if !unfocused.is_empty() {
            return Err(fail("focusing it failed", unfocused.into_iter().map(Rc::new).collect()));
        }
        if !entered {
            return Ok(());
        }
        let unentered = self.hooks.emit_serial::<WorkspaceEntered>(reference).await;
        if !unentered.is_empty() {
            return Err(fail("entering it failed", unentered.into_iter().map(Rc::new).collect()));
        }
        Ok(())
    }

    fn joined(
        self: &Rc<Self>,
        entered: bool,
        path: &str,
    ) -> LocalBoxFuture<'static, Result<(), WorkspaceOpenError>> {
        let key = (self.key_of)(path);
        let map = if entered { &self.entering } else { &self.focusing };
        if let Some(running) = map.borrow().get(&key).cloned() {
            return running.boxed_local();
        }
        let this = self.clone();
        let k = key.clone();
        let p = path.to_string();
        let call: Joined = async move {
            let result = this.clone().bring_forward(p, entered).await;
            let map = if entered { &this.entering } else { &this.focusing };
            map.borrow_mut().remove(&k);
            result
        }
        .boxed_local()
        .shared();
        map.borrow_mut().insert(key, call.clone());
        call.boxed_local()
    }

    pub(crate) fn handle_for(self: &Rc<Self>, path: &str) -> WorkspaceHandle {
        WorkspaceHandle {
            path: path.to_string(),
            key: (self.key_of)(path),
            core: self.clone(),
        }
    }

    fn entry_for(&self, key: &str) -> Option<OpenWorkspace> {
        self.open
            .borrow()
            .get(key)
            .cloned()
            .or_else(|| self.closing.borrow().get(key).map(|(e, _)| e.clone()))
    }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// The kernel. Cheap to clone; single-threaded.
#[derive(Clone)]
pub struct Core {
    inner: Rc<CoreInner>,
}

/// Which workspaces are open. What app code sees as `core.workspaces()`.
#[derive(Clone)]
pub struct OpenWorkspaces {
    core: Rc<CoreInner>,
}

impl OpenWorkspaces {
    pub fn is_open(&self, path: &str) -> bool {
        self.core.open.borrow().contains_key(&(self.core.key_of)(path))
    }

    pub fn list(&self) -> Vec<WorkspaceRef> {
        let open = self.core.open.borrow();
        self.core
            .open_order
            .borrow()
            .iter()
            .filter_map(|k| open.get(k).map(|e| e.reference.clone()))
            .collect()
    }

    /// Called after every open and close.
    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        self.core.listeners.subscribe(move |_| listener())
    }
}

/// Open and close a workspace's instances directly — for modules only.
/// App code opens a workspace through its handle, which also announces it.
#[derive(Clone)]
pub struct WorkspaceLifecycle {
    pub(crate) core: Rc<CoreInner>,
}

impl WorkspaceLifecycle {
    /// Create every module's workspace instance, in dependency order, then
    /// fire `workspace:opened`. Idempotent.
    pub async fn open(&self, path: &str) {
        let _ = self.core.clone().open_workspace(path.to_string()).await;
    }

    /// Fire `workspace:closing` (awaited), then dispose every instance in
    /// reverse dependency order. Idempotent; a second call joins the first.
    pub fn close(&self, path: &str) -> LocalBoxFuture<'static, ()> {
        self.core.close_workspace(path).boxed_local()
    }

    pub fn is_open(&self, path: &str) -> bool {
        OpenWorkspaces { core: self.core.clone() }.is_open(path)
    }

    pub fn list(&self) -> Vec<WorkspaceRef> {
        OpenWorkspaces { core: self.core.clone() }.list()
    }

    pub fn subscribe(&self, listener: impl Fn() + 'static) -> Subscription {
        OpenWorkspaces { core: self.core.clone() }.subscribe(listener)
    }
}

/// A workspace, open or not. Its module instances read while it is open —
/// and while it is closing, so `closing` handlers can reach what they tear
/// down.
#[derive(Clone)]
pub struct WorkspaceHandle {
    path: String,
    key: String,
    core: Rc<CoreInner>,
}

impl WorkspaceHandle {
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Identity: two spellings of one workspace share it.
    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn reference(&self) -> WorkspaceRef {
        WorkspaceRef {
            key: self.key.clone(),
            path: self.path.clone(),
        }
    }

    pub fn is_open(&self) -> bool {
        self.core.open.borrow().contains_key(&self.key)
    }

    /// Open it if it is not open, then announce the entry:
    /// `workspace:focused` and `workspace:entered`, each awaited. Calls for
    /// one workspace while one is in flight join it.
    pub fn open(&self) -> LocalBoxFuture<'static, Result<(), WorkspaceOpenError>> {
        self.core.joined(true, &self.path)
    }

    /// Open it if needed and bring it forward: `workspace:focused` only.
    pub fn focus(&self) -> LocalBoxFuture<'static, Result<(), WorkspaceOpenError>> {
        self.core.joined(false, &self.path)
    }

    /// Fire `workspace:closing` (awaited), then dispose its instances.
    pub fn close(&self) -> LocalBoxFuture<'static, ()> {
        self.core.close_workspace(&self.path).boxed_local()
    }

    /// This workspace's instance of `M`.
    pub fn get<M: Module>(&self) -> Result<Rc<M::Workspace>, WorkspaceClosedError> {
        let closed = || {
            WorkspaceClosedError(format!(
                "\"{}\" of {} is read while the workspace is not open.",
                M::NAME,
                self.path
            ))
        };
        let entry = self.core.entry_for(&self.key).ok_or_else(closed)?;
        let instance = entry.instances.borrow().get(&TypeId::of::<M>()).cloned();
        instance
            .ok_or_else(|| {
                WorkspaceClosedError(format!("\"{}\" has no workspace part (or is not registered).", M::NAME))
            })?
            .downcast::<M::Workspace>()
            .map_err(|_| closed())
    }
}

impl Core {
    /// Build the core: order the modules, then register every API,
    /// dependencies first. Fails on a configuration error (a duplicate, a
    /// cycle, an unprovided service).
    pub fn new(options: CreateCoreOptions) -> Result<Core, CoreConfigError> {
        let key_of = options
            .workspace_key
            .unwrap_or_else(|| Rc::new(|p: &str| p.to_string()));
        let on_error: OnError = options.on_error.unwrap_or_else(|| {
            Rc::new(|err: &anyhow::Error, where_: &str| log::error!("[core] {where_} failed: {err:#}"))
        });
        let hook_error = on_error.clone();
        let hooks = Hooks::new(
            options.executor.clone(),
            Rc::new(move |err, hook| hook_error(err, &format!("hook {hook}"))),
        );

        // Each provided service is a module whose API is the value, listed
        // first so it wins over the unprovided placeholder.
        let mut modules: Vec<Rc<dyn ErasedModule>> = options
            .services
            .provided
            .into_iter()
            .map(|p| Rc::new(p) as Rc<dyn ErasedModule>)
            .collect();
        modules.extend(options.modules.iter().map(|m| (m.make)()));
        let ordered = order_modules(modules)?;
        let workspace_modules = ordered.iter().filter(|m| m.has_workspace()).cloned().collect();

        let inner = Rc::new(CoreInner {
            apis: RefCell::new(HashMap::new()),
            hooks,
            executor: options.executor,
            on_error,
            key_of,
            ordered,
            workspace_modules,
            shutting_down: Cell::new(false),
            rolling_back: RefCell::default(),
            latest_call: RefCell::default(),
            next_call: Cell::new(0),
            open: RefCell::default(),
            open_order: RefCell::default(),
            closing: RefCell::default(),
            listeners: Listeners::new(),
            entering: RefCell::default(),
            focusing: RefCell::default(),
            disposers: RefCell::default(),
            booted: Cell::new(false),
            disposed: RefCell::new(None),
        });

        // Register phase: build every API, dependencies first.
        for module in inner.ordered.clone() {
            let ctx = inner.context_for(&module);
            let api = module
                .register(&ctx)
                .map_err(|err| match err.downcast::<CoreConfigError>() {
                    Ok(config) => config,
                    Err(other) => CoreConfigError(format!("register of \"{}\": {other:#}", module.name())),
                })?;
            inner.apis.borrow_mut().insert(module.id(), api);
        }
        Ok(Core { inner })
    }

    /// A module's API. Panics if it is not registered.
    pub fn use_<M: Module>(&self) -> Rc<M::Api> {
        self.try_use::<M>()
            .unwrap_or_else(|| panic!("CoreConfigError: Nothing named \"{}\" is registered.", M::NAME))
    }

    pub fn try_use<M: Module>(&self) -> Option<Rc<M::Api>> {
        self.inner
            .apis
            .borrow()
            .get(&TypeId::of::<M>())
            .cloned()
            .map(|a| a.downcast::<M::Api>().expect("api type"))
    }

    /// A provided service.
    pub fn service<S: Service>(&self) -> Rc<S::Value> {
        let slot = self
            .inner
            .apis
            .borrow()
            .get(&TypeId::of::<ServiceSlot<S>>())
            .cloned()
            .unwrap_or_else(|| panic!("CoreConfigError: Service \"{}\" is not provided.", S::NAME))
            .downcast::<Rc<S::Value>>()
            .expect("service type");
        (*slot).clone()
    }

    pub fn hooks(&self) -> &Hooks {
        &self.inner.hooks
    }

    pub fn executor(&self) -> Rc<dyn Executor> {
        self.inner.executor.clone()
    }

    /// Which workspaces are open. Opening goes through a handle.
    pub fn workspaces(&self) -> OpenWorkspaces {
        OpenWorkspaces {
            core: self.inner.clone(),
        }
    }

    /// The handle for a workspace, whether or not it is open.
    pub fn workspace(&self, path: &str) -> WorkspaceHandle {
        CoreInner::handle_for(&self.inner, path)
    }

    /// Run every module's `boot`, in dependency order. Once per core.
    pub fn boot(&self) {
        if self.inner.booted.replace(true) {
            return;
        }
        for module in self.inner.ordered.clone() {
            let ctx = self.inner.context_for(&module);
            let api = self.inner.apis.borrow().get(&module.id()).cloned().expect("registered");
            // Degrade, don't disappear: one module failing to boot must not
            // take the others (or the first render) down with it.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| module.boot(&api, &ctx)));
            match result {
                Ok(Some(sub)) => self.inner.disposers.borrow_mut().push(sub),
                Ok(None) => {}
                Err(panic) => {
                    let msg = panic
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_else(|| "panic".into());
                    self.inner
                        .report(&anyhow::anyhow!(msg), &format!("boot of \"{}\"", module.name()));
                }
            }
        }
        self.inner.hooks.emit::<CoreBooted>(());
    }

    /// Close every workspace, then run boot disposers in reverse order.
    pub fn dispose(&self) -> LocalBoxFuture<'static, ()> {
        self.inner.shutting_down.set(true);
        if let Some(done) = self.inner.disposed.borrow().clone() {
            return done.boxed_local();
        }
        let inner = self.inner.clone();
        let done: Done = async move {
            inner.hooks.emit_serial::<CoreShutdown>(()).await;
            let paths: Vec<String> = OpenWorkspaces { core: inner.clone() }
                .list()
                .into_iter()
                .map(|r| r.path)
                .collect();
            let closes: Vec<_> = paths.iter().map(|p| inner.close_workspace(p)).collect();
            futures::future::join_all(closes).await;
            let disposers: Vec<Subscription> = inner.disposers.borrow_mut().drain(..).collect();
            for sub in disposers.into_iter().rev() {
                drop(sub);
            }
        }
        .boxed_local()
        .shared();
        *self.inner.disposed.borrow_mut() = Some(done.clone());
        done.boxed_local()
    }

    /// The module names in boot order (for diagnostics).
    pub fn module_names(&self) -> Vec<&'static str> {
        self.inner.ordered.iter().map(|m| m.name()).collect()
    }
}
