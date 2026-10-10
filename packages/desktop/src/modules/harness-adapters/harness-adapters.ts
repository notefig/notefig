/**
 * Harness adapters — `core.harnessAdapters`: everything one harness does
 * differently from another, reached through one module instead of id
 * checks and vendor `_meta` reads spread across the agent subsystem
 * (MET-220). The seams move in one at a time; so far, how each harness is
 * handed the app's MCP tools.
 */
import type {
  HarnessDefinition,
  McpRegistrationMode,
} from "@notefig/shared/agent";
import { defineModule } from "@notefig/core";
import { platformModule } from "@/core/services";
import { harnessesModule } from "@/modules/agents/harnesses";
import type { HarnessAdapter } from "./adapter";
import { claudeCodeAdapter } from "./claude-code";
import { devinAdapter } from "./devin";
import { geminiCliAdapter } from "./gemini-cli";
import { openCodeAdapter } from "./opencode";

/** Each built-in harness's own adapter, by its definition's id. */
const BUILT_IN_ADAPTERS = new Map<string, HarnessAdapter>([
  ["claude-code", claudeCodeAdapter],
  ["opencode", openCodeAdapter],
  ["devin", devinAdapter],
  ["gemini-cli", geminiCliAdapter],
]);

/** The adapter each registration mode names — the only one a runtime
 *  custom harness can reach (by its `mcpRegistrationOverride`). */
const ADAPTER_BY_MODE: Record<McpRegistrationMode, HarnessAdapter> = {
  "session-new": claudeCodeAdapter,
  "opencode-config": openCodeAdapter,
  "devin-config": devinAdapter,
  none: geminiCliAdapter,
};

export interface HarnessAdaptersApi {
  /** The adapter for a harness: a built-in's own, else — a custom harness,
   *  data with no bespoke code — the one its registration mode names. */
  adapterFor(harness: HarnessDefinition): HarnessAdapter;
}

export function createHarnessAdapters(): HarnessAdaptersApi {
  return {
    adapterFor: (harness) =>
      BUILT_IN_ADAPTERS.get(harness.id) ??
      ADAPTER_BY_MODE[harness.mcpRegistration],
  };
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
