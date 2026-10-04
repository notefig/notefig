import type { AnyModule } from "./define-module";

export class CoreConfigError extends Error {
  override name = "CoreConfigError";
}

/**
 * Modules in dependency order: everything a module needs (at app level or
 * per workspace) comes before it. Modules with no constraint between them
 * keep the order they were listed in, so a root's list reads top to bottom.
 *
 * Throws at startup, naming the module, for a duplicate name, a need that is
 * neither a service nor a module, a workspace need on a module with no
 * workspace part, or a cycle (with its chain).
 */
export function orderModules(
  modules: readonly AnyModule[],
  serviceNames: ReadonlySet<string>,
): AnyModule[] {
  const byName = new Map<string, AnyModule>();
  for (const module of modules) {
    if (byName.has(module.name)) {
      throw new CoreConfigError(`Module "${module.name}" is registered twice.`);
    }
    if (serviceNames.has(module.name)) {
      throw new CoreConfigError(
        `Module "${module.name}" has the same name as a service.`,
      );
    }
    byName.set(module.name, module);
  }

  const edges = (module: AnyModule): string[] => {
    const out: string[] = [];
    for (const need of module.needs ?? []) {
      if (serviceNames.has(need)) continue;
      if (!byName.has(need)) {
        throw new CoreConfigError(
          `Module "${module.name}" needs "${need}", which is neither a service nor a registered module.`,
        );
      }
      out.push(need);
    }
    for (const need of module.workspace?.needs ?? []) {
      const target = byName.get(need);
      if (!target?.workspace) {
        throw new CoreConfigError(
          `Module "${module.name}" needs the workspace instance of "${need}", which has no workspace part.`,
        );
      }
      out.push(need);
    }
    return out;
  };

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
    for (const need of edges(module)) visit(byName.get(need)!);
    visiting.pop();
    done.add(module.name);
    ordered.push(module);
  };

  for (const module of modules) visit(module);
  return ordered;
}
