//! Declaring a module: the Rust form of `defineModule` / `defineService`.
//!
//! A module is a marker type implementing [`Module`]. Its `Api` is what
//! `core.use_::<M>()` hands back (the TS `CoreModules` entry), its
//! `Workspace` the per-workspace instance (`WorkspaceModules`). Another
//! module lists it in `needs` with [`ModuleRef::of`], which is also what
//! types `ctx.use_::<M>()`: using a module not listed panics, as the TS
//! core throws a `CoreConfigError`.

use std::any::{Any, TypeId};
use std::marker::PhantomData;
use std::rc::Rc;

use futures::future::LocalBoxFuture;

use crate::context::{ModuleContext, WorkspaceContext};
use crate::subscription::Subscription;
use crate::WorkspaceRef;

pub trait Module: 'static {
    /// Unique; used in errors and logs.
    const NAME: &'static str;
    /// What `register` builds and every `use_::<Self>()` gets. `()` for a
    /// module that only boots.
    type Api: 'static;
    /// The per-workspace instance. `()` with no `workspace` part.
    type Workspace: 'static;

    /// The modules this one uses, services included; they register and boot
    /// first. A needed module the root did not list is registered anyway.
    fn needs() -> Vec<ModuleRef> {
        Vec::new()
    }

    /// Build the API. No side effects belong here.
    fn register(ctx: &ModuleContext) -> Self::Api;

    /// Start subscriptions once every module has registered. Runs in
    /// dependency order; the subscription is dropped, in reverse order, when
    /// core shuts down.
    fn boot(_api: &Rc<Self::Api>, _ctx: &ModuleContext) -> Option<Subscription> {
        None
    }

    /// The per-workspace part, if this module has one.
    fn workspace() -> Option<WorkspacePart<Self>> {
        None
    }
}

pub type WorkspaceCreate<M> =
    fn(&WorkspaceContext, &Rc<<M as Module>::Api>) -> anyhow::Result<<M as Module>::Workspace>;
pub type WorkspaceDispose<M> = fn(
    Rc<<M as Module>::Workspace>,
    WorkspaceRef,
    Rc<<M as Module>::Api>,
) -> LocalBoxFuture<'static, anyhow::Result<()>>;

/// `workspace: { needs, create, dispose }`.
pub struct WorkspacePart<M: Module + ?Sized> {
    /// The modules whose instance for this workspace this one uses.
    pub needs: Vec<ModuleRef>,
    pub create: WorkspaceCreate<M>,
    /// Release what the instance holds (processes, watchers, caches).
    pub dispose: Option<WorkspaceDispose<M>>,
}

impl<M: Module> WorkspacePart<M> {
    pub fn new(create: WorkspaceCreate<M>) -> Self {
        Self {
            needs: Vec::new(),
            create,
            dispose: None,
        }
    }

    pub fn needs(mut self, needs: Vec<ModuleRef>) -> Self {
        self.needs = needs;
        self
    }

    pub fn dispose(mut self, dispose: WorkspaceDispose<M>) -> Self {
        self.dispose = Some(dispose);
        self
    }
}

/// A value the root hands every module that needs it (`createCore({ services })`).
/// Declare one with a marker type; list it in `needs` with
/// [`ModuleRef::service`] and read it with `ctx.service::<S>()`.
pub trait Service: 'static {
    const NAME: &'static str;
    type Value: ?Sized + 'static;
}

// ---------------------------------------------------------------------------
// Erasure: what the kernel works with.
// ---------------------------------------------------------------------------

pub(crate) type Erased = Rc<dyn Any>;

pub(crate) trait ErasedModule {
    fn name(&self) -> &'static str;
    fn id(&self) -> TypeId;
    fn needs(&self) -> Vec<ModuleRef>;
    fn register(&self, ctx: &ModuleContext) -> anyhow::Result<Erased>;
    fn boot(&self, api: &Erased, ctx: &ModuleContext) -> Option<Subscription>;
    fn has_workspace(&self) -> bool;
    fn workspace_needs(&self) -> Vec<ModuleRef>;
    fn create(&self, ctx: &WorkspaceContext, api: &Erased) -> anyhow::Result<Erased>;
    fn dispose(
        &self,
        instance: Erased,
        workspace: WorkspaceRef,
        api: Erased,
    ) -> Option<LocalBoxFuture<'static, anyhow::Result<()>>>;
}

/// A module (or service) as another module's `needs` names it, and as a
/// root lists it.
#[derive(Clone, Copy)]
pub struct ModuleRef {
    pub(crate) name: &'static str,
    pub(crate) id: fn() -> TypeId,
    pub(crate) make: fn() -> Rc<dyn ErasedModule>,
}

impl std::fmt::Debug for ModuleRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name)
    }
}

impl ModuleRef {
    pub fn of<M: Module>() -> Self {
        Self {
            name: M::NAME,
            id: TypeId::of::<M>,
            make: || Rc::new(Typed::<M>(PhantomData)),
        }
    }

    pub fn service<S: Service>() -> Self {
        Self {
            name: S::NAME,
            id: TypeId::of::<ServiceSlot<S>>,
            make: || Rc::new(Unprovided::<S>(PhantomData)),
        }
    }

    pub fn name(&self) -> &'static str {
        self.name
    }

    pub(crate) fn type_id(&self) -> TypeId {
        (self.id)()
    }
}

/// The TypeId a service is stored under.
pub(crate) struct ServiceSlot<S: ?Sized>(PhantomData<S>);

struct Typed<M>(PhantomData<M>);

impl<M: Module> ErasedModule for Typed<M> {
    fn name(&self) -> &'static str {
        M::NAME
    }
    fn id(&self) -> TypeId {
        TypeId::of::<M>()
    }
    fn needs(&self) -> Vec<ModuleRef> {
        M::needs()
    }
    fn register(&self, ctx: &ModuleContext) -> anyhow::Result<Erased> {
        let api: Rc<M::Api> = Rc::new(M::register(ctx));
        Ok(api as Erased)
    }
    fn boot(&self, api: &Erased, ctx: &ModuleContext) -> Option<Subscription> {
        let api = api.clone().downcast::<M::Api>().expect("api type");
        M::boot(&api, ctx)
    }
    fn has_workspace(&self) -> bool {
        M::workspace().is_some()
    }
    fn workspace_needs(&self) -> Vec<ModuleRef> {
        M::workspace().map(|w| w.needs).unwrap_or_default()
    }
    fn create(&self, ctx: &WorkspaceContext, api: &Erased) -> anyhow::Result<Erased> {
        let part = M::workspace().expect("create is only called with a workspace part");
        let api = api.clone().downcast::<M::Api>().expect("api type");
        let instance: Rc<M::Workspace> = Rc::new((part.create)(ctx, &api)?);
        Ok(instance as Erased)
    }
    fn dispose(
        &self,
        instance: Erased,
        workspace: WorkspaceRef,
        api: Erased,
    ) -> Option<LocalBoxFuture<'static, anyhow::Result<()>>> {
        let dispose = M::workspace()?.dispose?;
        let instance = instance.downcast::<M::Workspace>().expect("instance type");
        let api = api.downcast::<M::Api>().expect("api type");
        Some(dispose(instance, workspace, api))
    }
}

/// A service the root did not provide: needing it fails startup.
struct Unprovided<S: ?Sized>(PhantomData<S>);

impl<S: Service> ErasedModule for Unprovided<S> {
    fn name(&self) -> &'static str {
        S::NAME
    }
    fn id(&self) -> TypeId {
        TypeId::of::<ServiceSlot<S>>()
    }
    fn needs(&self) -> Vec<ModuleRef> {
        Vec::new()
    }
    fn register(&self, _: &ModuleContext) -> anyhow::Result<Erased> {
        Err(crate::CoreConfigError(format!(
            "Service \"{}\" is needed but the root did not provide it.",
            S::NAME
        ))
        .into())
    }
    fn boot(&self, _: &Erased, _: &ModuleContext) -> Option<Subscription> {
        None
    }
    fn has_workspace(&self) -> bool {
        false
    }
    fn workspace_needs(&self) -> Vec<ModuleRef> {
        Vec::new()
    }
    fn create(&self, _: &WorkspaceContext, _: &Erased) -> anyhow::Result<Erased> {
        unreachable!()
    }
    fn dispose(&self, _: Erased, _: WorkspaceRef, _: Erased) -> Option<LocalBoxFuture<'static, anyhow::Result<()>>> {
        None
    }
}

/// A service the root provided: its "API" is the value.
pub(crate) struct Provided {
    pub name: &'static str,
    pub id: TypeId,
    pub value: Erased,
}

impl ErasedModule for Provided {
    fn name(&self) -> &'static str {
        self.name
    }
    fn id(&self) -> TypeId {
        self.id
    }
    fn needs(&self) -> Vec<ModuleRef> {
        Vec::new()
    }
    fn register(&self, _: &ModuleContext) -> anyhow::Result<Erased> {
        Ok(self.value.clone())
    }
    fn boot(&self, _: &Erased, _: &ModuleContext) -> Option<Subscription> {
        None
    }
    fn has_workspace(&self) -> bool {
        false
    }
    fn workspace_needs(&self) -> Vec<ModuleRef> {
        Vec::new()
    }
    fn create(&self, _: &WorkspaceContext, _: &Erased) -> anyhow::Result<Erased> {
        unreachable!()
    }
    fn dispose(&self, _: Erased, _: WorkspaceRef, _: Erased) -> Option<LocalBoxFuture<'static, anyhow::Result<()>>> {
        None
    }
}

/// What the root hands every module: `Services::new().with::<PlatformService>(rc)`.
#[derive(Default)]
pub struct Services {
    pub(crate) provided: Vec<Provided>,
}

impl Services {
    pub fn new() -> Self {
        Self::default()
    }

    /// Provide a service. The value is stored as `Rc<Rc<S::Value>>`-free:
    /// `ctx.service::<S>()` hands back the same `Rc<S::Value>`.
    pub fn with<S: Service>(mut self, value: Rc<S::Value>) -> Self {
        self.provided.push(Provided {
            name: S::NAME,
            id: TypeId::of::<ServiceSlot<S>>(),
            value: Rc::new(value) as Erased,
        });
        self
    }
}
