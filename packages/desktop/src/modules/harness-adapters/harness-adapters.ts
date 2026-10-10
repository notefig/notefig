/**
 * Harness adapters — `core.harnessAdapters`: everything one harness does
 * differently from another (how it spawns and is handed the app's tools,
 * what it advertises and reads at initialize, how it reports usage and
 * limits), reached through one module instead of id checks and vendor
 * `_meta` reads spread across the agent subsystem (MET-220).
 *
 * Empty for now: the seams move in one at a time.
 */
import { defineModule } from "@notefig/core";
import { platformModule } from "@/core/services";
import { harnessesModule } from "@/modules/agents/harnesses";

export interface HarnessAdaptersApi {}

export function createHarnessAdapters(): HarnessAdaptersApi {
  return {};
}

declare module "@notefig/core" {
  interface CoreModules {
    harnessAdapters: HarnessAdaptersApi;
  }
}

export const harnessAdaptersModule = defineModule({
  name: "harnessAdapters",
  // Harnesses: an adapter is resolved from a configured definition, custom
  // entries included. Platform: registering the app's tools writes files,
  // and discovering a harness's models spawns it.
  needs: [platformModule, harnessesModule],
  register: () => createHarnessAdapters(),
});
