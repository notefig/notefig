/**
 * Harnesses as the rest of the app sees them — `core.harnesses`. Anything
 * that names a harness outside a session (a usage chart, a session list)
 * needs the same few answers, and this is where the agent subsystem gives
 * them, so no view carries a table of harness quirks of its own:
 *
 * - the configured definitions: built-ins merged with this machine's
 *   overrides and custom entries, read live from the harness settings KV;
 * - a label for any id, including one whose custom entry was deleted (its
 *   sessions keep the raw id).
 *
 * What a harness does differently at run time is its adapter's
 * (`core.harnessAdapters`).
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

export interface HarnessesApi {
  /** Built-ins with this machine's overrides and custom entries applied —
   *  every harness as configured, whether or not its binary was found.
   *  Built-ins alone until the settings have loaded. */
  configured(): HarnessDefinition[];
  /** A harness's display name: configured first, built-in next, the raw id
   *  last. */
  label(harnessId: string): string;
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
