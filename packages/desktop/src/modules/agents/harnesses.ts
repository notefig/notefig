/**
 * Harnesses as the rest of the app sees them — `core.harnesses`. Anything
 * that names a harness outside a session (a usage chart, a session list)
 * needs the same few answers, and this is where the agent subsystem gives
 * them, so no view carries a table of harness quirks of its own:
 *
 * - the configured definitions: built-ins merged with this machine's
 *   overrides and custom entries, read live from the harness settings KV;
 * - a label for any id, including one whose custom entry was deleted (its
 *   sessions keep the raw id);
 * - what each built-in reports about usage beyond tokens, as the spike
 *   found it (docs/architecture/spikes/acp-token-usage-spike.md): cost on
 *   its `usage_update`, account limits in its `_meta`. A view uses this to
 *   grey out what a harness will never fill, rather than show an empty
 *   chart as if nothing had been spent.
 */
import {
  BUILT_IN_HARNESSES,
  parseCustomHarnessEntries,
  parseHarnessOverrides,
  resolveEffectiveHarnesses,
  type HarnessDefinition,
} from "@notefig/shared/agent";
import { defineModule } from "@notefig/core";
import { kvModule, type KvApi } from "@/modules/kv";
import {
  HARNESS_CUSTOM_KEY,
  HARNESS_OVERRIDES_KEY,
  HARNESS_SETTINGS_NAMESPACE,
} from "./harness-discovery";

export type UsageReporting = {
  /** Sends a running cost (`usage_update.cost`). */
  cost: boolean;
  /** Sends account limits a reader in `usage-limits.ts` understands. */
  limits: boolean;
};

const KNOWN_REPORTING: Record<string, UsageReporting> = {
  "claude-code": { cost: true, limits: true },
  opencode: { cost: true, limits: false },
  devin: { cost: false, limits: false },
  "gemini-cli": { cost: false, limits: false },
};

export interface HarnessesApi {
  /** Built-ins with this machine's overrides and custom entries applied —
   *  every harness as configured, whether or not its binary was found.
   *  Built-ins alone until the settings have loaded. */
  configured(): HarnessDefinition[];
  /** A harness's display name: configured first, built-in next, the raw id
   *  last. */
  label(harnessId: string): string;
  /** What `harnessId` reports about usage. `seen` is what its own data
   *  shows — a cost or a limits report already recorded — and counts even
   *  where the table says otherwise, since an adapter update can start
   *  sending either; a harness not in the table (a custom one) is judged by
   *  `seen` alone. */
  reporting(harnessId: string, seen?: Partial<UsageReporting>): UsageReporting;
}

export function createHarnesses({ kv }: { kv: Pick<KvApi, "collection"> }): HarnessesApi {
  const settings = kv.collection(HARNESS_SETTINGS_NAMESPACE);
  const configured = () =>
    resolveEffectiveHarnesses(
      parseHarnessOverrides(settings.get(HARNESS_OVERRIDES_KEY)?.value),
      parseCustomHarnessEntries(settings.get(HARNESS_CUSTOM_KEY)?.value),
    );
  return {
    configured,
    label(harnessId) {
      return (
        configured().find((harness) => harness.id === harnessId)?.label ??
        BUILT_IN_HARNESSES.find((harness) => harness.id === harnessId)?.label ??
        harnessId
      );
    },
    reporting(harnessId, seen = {}) {
      const known = KNOWN_REPORTING[harnessId];
      return {
        cost: !!known?.cost || !!seen.cost,
        limits: !!known?.limits || !!seen.limits,
      };
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    harnesses: HarnessesApi;
  }
}

export const harnessesModule = defineModule({
  name: "harnesses",
  needs: [kvModule],
  register: (ctx) => createHarnesses({ kv: ctx.use("kv") }),
});
