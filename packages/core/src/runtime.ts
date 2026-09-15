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
 * shape, and it was rejected on a measurement of the *projected* move set:
 * 18 host reads sitting at the bottom of call chains dozens of frames deep,
 * so parameter-threading would rewrite hundreds of signatures — each then
 * part of this package's API — to serve those 18.
 *
 * Be honest about where that stands today: **one** module reads this
 * (`desktop/src/utils/file-sync.ts`, for `editor.adoptWrite`), nothing inside
 * `packages/core` reads it at all, and the CLI — the second host cited as the
 * justification — passes its host explicitly as a parameter instead
 * (`HeadlessSessionSpec.host`). So the exception is currently carrying one
 * call site, and the argument for it is a forecast, not a measurement. If the
 * remaining cuts land and the count stays low, delete this and pass the host.
 *
 * This is a service-locator shape, and the house preference is direct imports
 * over registration indirection. The exception's justification is a genuine
 * second host — the CLI, in its own process, with no DOM — rather than a
 * registry invented to merge files.
 *
 * ## What this shape cannot survive
 *
 * One binding per process works only while a process serves one portal.
 * `ServiceHost` mixes two lifetimes: `platform`, `path` and `appDirName` are
 * process-scoped, while `editor` and `telemetry` are per-portal — one
 * window's editor, one user's consent. When MET-185 puts N portals on one
 * service, `getServiceHost().editor` has no way to say *which* portal should
 * adopt a write. The fix then is splitting the contract along that seam, not
 * making the binding reconfigurable — reconfiguring mid-flight would let two
 * portals race over one set of collections. Worth doing while there is still
 * exactly one reader to move.
 *
 * Rebinding is not prevented, because the desktop test host installs a fresh
 * host per test. It is a boot-time call everywhere else.
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

// No `resetCoreForTests`: it was exported from the package index — a
// test-only unset in the production API — and had zero callers, because
// suites install their own host by calling `configureCore` again.
