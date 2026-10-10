/**
 * Harness adapters — `core.harnessAdapters`: everything one harness does
 * differently from another, reached through one module instead of id
 * checks and vendor `_meta` reads spread across the agent subsystem
 * (MET-220). The seams move in one at a time; so far, how each harness is
 * handed the app's MCP tools and what it reports about usage.
 */
import {
  BUILT_IN_HARNESSES,
  type HarnessDefinition,
  type McpRegistrationMode,
} from "@notefig/shared/agent";
import { defineModule } from "@notefig/core";
import { platformModule } from "@/core/services";
import { harnessesModule, type HarnessesApi } from "@/modules/agents/harnesses";
import { NO_REPORTING, type HarnessAdapter, type UsageReporting } from "./adapter";
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

/** A custom harness — settings data, no code of its own — registers the
 *  app's tools the way its mode names (by its `mcpRegistrationOverride`)
 *  and declares nothing it reports: what it has sent is the only evidence. */
const CUSTOM_ADAPTERS: Record<McpRegistrationMode, HarnessAdapter> = {
  "session-new": { ...claudeCodeAdapter, reporting: NO_REPORTING },
  "opencode-config": { ...openCodeAdapter, reporting: NO_REPORTING },
  "devin-config": { ...devinAdapter, reporting: NO_REPORTING },
  none: { ...geminiCliAdapter, reporting: NO_REPORTING },
};

export interface HarnessAdaptersApi {
  /** The adapter for a harness: a built-in's own, else — a custom harness —
   *  the one its registration mode names. */
  adapterFor(harness: HarnessDefinition): HarnessAdapter;
  /** What `harnessId` reports about usage. `seen` is what its own data
   *  shows — a cost or a limits report already recorded — and counts even
   *  where its adapter says otherwise, since an adapter update can start
   *  sending either; an id with no definition left (a deleted custom entry)
   *  is judged by `seen` alone. */
  reporting(harnessId: string, seen?: Partial<UsageReporting>): UsageReporting;
}

export function createHarnessAdapters({
  harnesses,
}: {
  /** The configured definitions, custom entries included. */
  harnesses: Pick<HarnessesApi, "configured">;
}): HarnessAdaptersApi {
  const adapterFor = (harness: HarnessDefinition) =>
    BUILT_IN_ADAPTERS.get(harness.id) ?? CUSTOM_ADAPTERS[harness.mcpRegistration];
  return {
    adapterFor,
    reporting(harnessId, seen = {}) {
      // A built-in switched off in settings is no longer configured, but its
      // sessions still chart.
      const definition =
        harnesses.configured().find((harness) => harness.id === harnessId) ??
        BUILT_IN_HARNESSES.find((harness) => harness.id === harnessId);
      const known = definition ? adapterFor(definition).reporting : NO_REPORTING;
      return {
        cost: known.cost || !!seen.cost,
        limits: known.limits || !!seen.limits,
      };
    },
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
  register: (ctx) =>
    createHarnessAdapters({ harnesses: ctx.use("harnesses") }),
});
