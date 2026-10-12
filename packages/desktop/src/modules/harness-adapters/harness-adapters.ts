/**
 * Harness adapters — `core.harnessAdapters`: everything one harness does
 * differently from another, reached through one module instead of id
 * checks and vendor `_meta` reads spread across the agent subsystem
 * (MET-220). The seams move in one at a time; so far, how each harness is
 * handed the app's MCP tools and what it reports about usage.
 */
import type {
  HarnessDefinition,
  McpRegistrationMode,
} from "@notefig/shared/agent";
import { defineModule } from "@notefig/core";
import { platformModule } from "@/core/services";
import {
  KNOWN_TOOL_PREFIXES,
  NO_REPORTING,
  type HarnessAdapter,
  type HarnessMark,
} from "./adapter";
import {
  claudeCodeAdapter,
  claudeLimits,
  claudeModelRows,
  claudeUpdateModel,
} from "./claude-code";
import {
  DEVIN_CLIENT_META,
  devinAdapter,
  devinAgentOf,
  devinUsageByMeta,
} from "./devin";
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
 *  app's tools the way its mode names (by its `mcpRegistrationOverride`),
 *  borrowing only that from the built-in whose mode it is. It declares
 *  nothing it reports (what it has sent is the only evidence) and has no
 *  brand mark. What it sends is read in every known vendor's shape, so a
 *  custom entry running a known adapter (Devin under another id, a fork of
 *  claude-agent-acp) still counts usage, tags subagents and shows limits the
 *  way it does. */
function customAdapter(registersLike: HarnessAdapter): HarnessAdapter {
  return {
    onInvoke: registersLike.onInvoke,
    reporting: NO_REPORTING,
    toolNamePrefixes: KNOWN_TOOL_PREFIXES,
    clientMeta: DEVIN_CLIENT_META,
    usage: {
      ...devinUsageByMeta,
      modelRows: claudeModelRows,
      updateModel: claudeUpdateModel,
    },
    agentOf: devinAgentOf,
    limits: claudeLimits,
  };
}

const CUSTOM_ADAPTERS: Record<McpRegistrationMode, HarnessAdapter> = {
  "session-new": customAdapter(claudeCodeAdapter),
  "opencode-config": customAdapter(openCodeAdapter),
  "devin-config": customAdapter(devinAdapter),
  none: customAdapter(geminiCliAdapter),
};

/** A harness id's brand mark: a built-in's own; none for a custom harness
 *  or an id whose entry is gone (its sessions keep the raw id). Static, so
 *  views outside core (the marketing site) draw it too. */
export function harnessLogo(harnessId: string): HarnessMark | undefined {
  return BUILT_IN_ADAPTERS.get(harnessId)?.logo;
}

export interface HarnessAdaptersApi {
  /** The adapter for a harness: a built-in's own, else — a custom harness —
   *  the one its registration mode names. */
  adapterFor(harness: HarnessDefinition): HarnessAdapter;
}

export function createHarnessAdapters(): HarnessAdaptersApi {
  return {
    adapterFor: (harness) =>
      BUILT_IN_ADAPTERS.get(harness.id) ?? CUSTOM_ADAPTERS[harness.mcpRegistration],
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    harnessAdapters: HarnessAdaptersApi;
  }
}

export const harnessAdaptersModule = defineModule({
  name: "harnessAdapters",
  // Platform: registering the app's tools writes files, and discovering a
  // harness's models spawns it. An adapter is resolved from the definition
  // it is handed, so nothing here needs the harnesses: they need it.
  needs: [platformModule],
  register: () => createHarnessAdapters(),
});
