/**
 * The app's one core, for code that runs outside React (event handlers in
 * plain modules, entity functions, agent tools). React code uses
 * `useCore()` from `@notefig/core/react` instead.
 *
 * A leaf on purpose: importing it pulls in no module, so any file can reach
 * the core without joining an import cycle. The composition root installs
 * the core it builds; tests install their own.
 */
import type { Core } from "@notefig/core";

let current: Core | null = null;

export function installAppCore(core: Core | null): void {
  current = core;
}

export function appCore(): Core {
  if (!current) {
    throw new Error(
      "No app core is installed. Roots install one through createAppCore; tests through createTestCore.",
    );
  }
  return current;
}
