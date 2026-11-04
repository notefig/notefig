//! Modules in dependency order (port of `order.ts`).

use std::any::TypeId;
use std::collections::HashMap;
use std::rc::Rc;

use crate::module::ErasedModule;
use crate::CoreConfigError;

/// The listed modules, plus every module they need that the list leaves out
/// (transitively), in that order. A listed module wins over a needed one.
fn with_needed_modules(
    modules: Vec<Rc<dyn ErasedModule>>,
) -> Result<(Vec<Rc<dyn ErasedModule>>, HashMap<TypeId, usize>), CoreConfigError> {
    let mut list: Vec<Rc<dyn ErasedModule>> = Vec::new();
    let mut by_id: HashMap<TypeId, usize> = HashMap::new();
    let mut names: HashMap<&'static str, TypeId> = HashMap::new();
    for module in modules {
        if by_id.contains_key(&module.id()) || names.contains_key(module.name()) {
            return Err(CoreConfigError(format!(
                "Module \"{}\" is registered twice.",
                module.name()
            )));
        }
        names.insert(module.name(), module.id());
        by_id.insert(module.id(), list.len());
        list.push(module);
    }
    let mut i = 0;
    while i < list.len() {
        let module = list[i].clone();
        let needed = module.needs().into_iter().chain(module.workspace_needs());
        for need in needed {
            let id = need.type_id();
            if by_id.contains_key(&id) {
                continue;
            }
            if names.contains_key(need.name) {
                return Err(CoreConfigError(format!(
                    "Two different modules are named \"{}\".",
                    need.name
                )));
            }
            names.insert(need.name, id);
            by_id.insert(id, list.len());
            list.push((need.make)());
        }
        i += 1;
    }
    Ok((list, by_id))
}

/// Modules in dependency order: everything a module needs (at app level or
/// per workspace) comes before it. Modules with no constraint between them
/// keep the order they were listed in. Fails, naming the module, for a
/// duplicate, a workspace need on a module with no workspace part, or a
/// cycle (with its chain).
pub(crate) fn order_modules(
    modules: Vec<Rc<dyn ErasedModule>>,
) -> Result<Vec<Rc<dyn ErasedModule>>, CoreConfigError> {
    let (list, by_id) = with_needed_modules(modules)?;
    let mut edges: Vec<Vec<usize>> = Vec::with_capacity(list.len());
    for module in &list {
        let mut out: Vec<usize> = module.needs().iter().map(|n| by_id[&n.type_id()]).collect();
        for need in module.workspace_needs() {
            let idx = by_id[&need.type_id()];
            if !list[idx].has_workspace() {
                return Err(CoreConfigError(format!(
                    "Module \"{}\" needs the workspace instance of \"{}\", which has no workspace part.",
                    module.name(),
                    need.name
                )));
            }
            out.push(idx);
        }
        edges.push(out);
    }

    let mut ordered = Vec::with_capacity(list.len());
    let mut done = vec![false; list.len()];
    let mut visiting: Vec<usize> = Vec::new();

    fn visit(
        i: usize,
        list: &[Rc<dyn ErasedModule>],
        edges: &[Vec<usize>],
        done: &mut [bool],
        visiting: &mut Vec<usize>,
        ordered: &mut Vec<Rc<dyn ErasedModule>>,
    ) -> Result<(), CoreConfigError> {
        if done[i] {
            return Ok(());
        }
        if let Some(at) = visiting.iter().position(|&v| v == i) {
            let chain: Vec<&str> = visiting[at..]
                .iter()
                .chain(std::iter::once(&i))
                .map(|&v| list[v].name())
                .collect();
            return Err(CoreConfigError(format!(
                "Modules need each other in a cycle: {}",
                chain.join(" → ")
            )));
        }
        visiting.push(i);
        for &need in &edges[i] {
            visit(need, list, edges, done, visiting, ordered)?;
        }
        visiting.pop();
        done[i] = true;
        ordered.push(list[i].clone());
        Ok(())
    }

    for i in 0..list.len() {
        visit(i, &list, &edges, &mut done, &mut visiting, &mut ordered)?;
    }
    Ok(ordered)
}
