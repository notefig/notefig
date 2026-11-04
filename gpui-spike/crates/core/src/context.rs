//! What a module is handed: `ModuleContext` and `WorkspaceContext`.

use std::any::TypeId;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::core::{CoreInner, WorkspaceHandle, WorkspaceLifecycle};
use crate::executor::Executor;
use crate::hooks::Hooks;
use crate::module::{Erased, Module, ModuleRef, Service, ServiceSlot};
use crate::WorkspaceRef;

#[derive(Clone)]
pub struct ModuleContext {
    pub(crate) module: &'static str,
    pub(crate) needs: Rc<HashSet<TypeId>>,
    pub(crate) core: Rc<CoreInner>,
}

impl ModuleContext {
    fn api(&self, id: TypeId, name: &str) -> Erased {
        if !self.needs.contains(&id) {
            panic!(
                "CoreConfigError: Module \"{}\" uses \"{}\" without listing it in needs.",
                self.module, name
            );
        }
        self.core
            .apis
            .borrow()
            .get(&id)
            .cloned()
            .unwrap_or_else(|| panic!("\"{name}\" is used before it registered"))
    }

    /// Another module's API. Only modules listed in `needs`.
    pub fn use_<M: Module>(&self) -> Rc<M::Api> {
        self.api(TypeId::of::<M>(), M::NAME)
            .downcast::<M::Api>()
            .expect("api type")
    }

    /// A service the root provided. Only services listed in `needs`.
    pub fn service<S: Service>(&self) -> Rc<S::Value> {
        let slot = self
            .api(TypeId::of::<ServiceSlot<S>>(), S::NAME)
            .downcast::<Rc<S::Value>>()
            .expect("service type");
        (*slot).clone()
    }

    pub fn hooks(&self) -> &Hooks {
        &self.core.hooks
    }

    pub fn executor(&self) -> Rc<dyn Executor> {
        self.core.executor.clone()
    }

    /// Open and close workspaces' instances directly — for modules only,
    /// such as one restoring the workspaces a previous run left open.
    pub fn workspaces(&self) -> WorkspaceLifecycle {
        WorkspaceLifecycle {
            core: self.core.clone(),
        }
    }

    /// Any workspace's handle, as `core.workspace(path)`.
    pub fn workspace_handle(&self, path: &str) -> WorkspaceHandle {
        CoreInner::handle_for(&self.core, path)
    }

    pub fn module_name(&self) -> &'static str {
        self.module
    }
}

#[derive(Clone)]
pub struct WorkspaceContext {
    pub(crate) base: ModuleContext,
    pub(crate) workspace: WorkspaceRef,
    pub(crate) workspace_needs: Rc<HashSet<TypeId>>,
    pub(crate) instances: Rc<RefCell<HashMap<TypeId, Erased>>>,
}

impl std::ops::Deref for WorkspaceContext {
    type Target = ModuleContext;
    fn deref(&self) -> &ModuleContext {
        &self.base
    }
}

impl WorkspaceContext {
    pub fn workspace(&self) -> &WorkspaceRef {
        &self.workspace
    }

    /// Another module's instance for this workspace. Only `workspace.needs`.
    pub fn use_workspace<M: Module>(&self) -> Rc<M::Workspace> {
        let id = TypeId::of::<M>();
        if !self.workspace_needs.contains(&id) {
            panic!(
                "CoreConfigError: Module \"{}\" uses the workspace instance of \"{}\" without listing it in workspace.needs.",
                self.base.module,
                M::NAME
            );
        }
        self.instances
            .borrow()
            .get(&id)
            .cloned()
            .expect("needed workspace instances are created first")
            .downcast::<M::Workspace>()
            .expect("instance type")
    }
}

pub(crate) fn needs_set(needs: &[ModuleRef]) -> Rc<HashSet<TypeId>> {
    Rc::new(needs.iter().map(|n| n.type_id()).collect())
}
