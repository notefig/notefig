import type { AnyModule } from "./define-module";

export class CoreConfigError extends Error {
  override name = "CoreConfigError";
}

/**
 * The listed modules by name, plus every module they need that the list
 * leaves out (transitively), in that order. A listed module wins over a
 * needed one of the same name.
 */
function withNeededModules(
  modules: readonly AnyModule[],
): Map<string, AnyModule> {
  const byName = new Map<string, AnyModule>();
  for (const module of modules) {
    if (byName.has(module.name)) {
      throw new CoreConfigError(`Module "${module.name}" is registered twice.`);
    }
    byName.set(module.name, module);
  }
  // Iterating a Map visits entries added during the loop.
  for (const module of byName.values()) {
    const needed = [
      ...(module.needs ?? []),
      ...(module.workspace?.needs ?? []),
    ];
    for (const need of needed) {
      if (!byName.has(need.name)) {
        byName.set(need.name, need);
      }
    }
  }
  return byName;
}

/** The names a module must come after; throws on a workspace need core
 *  can't meet. */
function edgesOf(
  module: AnyModule,
  byName: ReadonlyMap<string, AnyModule>,
): string[] {
  const out = (module.needs ?? []).map((need) => need.name);
  for (const need of module.workspace?.needs ?? []) {
    if (!byName.get(need.name)!.workspace) {
      throw new CoreConfigError(
        `Module "${module.name}" needs the workspace instance of "${need.name}", which has no workspace part.`,
      );
    }
    out.push(need.name);
  }
  return out;
}

/**
 * Modules in dependency order: everything a module needs (at app level or
 * per workspace) comes before it. A needed module the list leaves out is
 * added, after the ones listed; a listed module wins over a needed one of
 * the same name. Modules with no constraint between them keep the order
 * they were listed in, so a root's list reads top to bottom.
 *
 * Throws at startup, naming the module, for a duplicate name, a workspace
 * need on a module with no workspace part, or a cycle (with its chain).
 */
export function orderModules(modules: readonly AnyModule[]): AnyModule[] {
  const byName = withNeededModules(modules);
  const ordered: AnyModule[] = [];
  const done = new Set<string>();
  const visiting: string[] = [];

  const visit = (module: AnyModule) => {
    if (done.has(module.name)) return;
    const at = visiting.indexOf(module.name);
    if (at !== -1) {
      const chain = [...visiting.slice(at), module.name].join(" → ");
      throw new CoreConfigError(`Modules need each other in a cycle: ${chain}`);
    }
    visiting.push(module.name);
    for (const need of edgesOf(module, byName)) {
      visit(byName.get(need)!);
    }
    visiting.pop();
    done.add(module.name);
    ordered.push(module);
  };

  for (const module of byName.values()) visit(module);
  return ordered;
}
