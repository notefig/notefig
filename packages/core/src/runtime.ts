/**
 * The core's binding to its host.
 *
 * Every module in this package that needs something window-flavored reads it
 * from here, so there is exactly one place a host is supplied and exactly one
 * place to look when asking what the core depends on.
 *
 * ## Why a module-scope binding rather than a parameter
 *
 * Threading a `host` argument through every signature would be the purer
 * shape, and it was rejected on measurement: across the whole move set the
 * core touches its host at 18 call sites, but those sites sit at the bottom
 * of call chains dozens of frames deep. Parameter-threading would rewrite
 * hundreds of signatures to serve 18 reads, and every one of those signatures
 * would then be part of the package's API surface.
 *
 * This is a service-locator shape, and the house preference is direct imports
 * over registration indirection. The justification for the exception is that
 * there is a genuine second host — the CLI, in its own process, with no DOM —
 * rather than a registry invented to merge files. The ticket's "lifecycle-
 * neutral entry point callable by both hosts" is this.
 *
 * The binding is write-once per process and has no unset: a core that could
 * be reconfigured mid-flight would let two hosts race over one set of
 * collections. Tests that need a different host get a fresh module registry.
 */
import type { ServiceHost } from "./host";

let host: ServiceHost | undefined;

export class CoreNotConfiguredError extends Error {
  constructor() {
    super(
      "the core was used before configureCore() — a host must be supplied at boot",
    );
    this.name = "CoreNotConfiguredError";
  }
}

/**
 * Supply the host. Called once, at boot, by whoever is hosting the core:
 * the desktop app from its entry point, the CLI from its command.
 */
export function configureCore(serviceHost: ServiceHost): void {
  host = serviceHost;
}

/**
 * The configured host. Throws rather than returning undefined: reaching for
 * a host before one exists is a boot-order bug, and the loud version is the
 * one that gets fixed.
 */
export function getServiceHost(): ServiceHost {
  if (!host) throw new CoreNotConfiguredError();
  return host;
}

/** Test-only escape hatch: drop the binding so a suite can install its own. */
export function resetCoreForTests(): void {
  host = undefined;
}
