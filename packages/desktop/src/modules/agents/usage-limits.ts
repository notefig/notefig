/**
 * Reads a harness's account limits (rate-limit windows, plan utilization)
 * off what it sends, into the harness-neutral `UsageLimits`. ACP has no
 * field for this; each harness that reports limits does so in its own
 * `_meta`, which its adapter's `limits` reads — nothing here knows the
 * vendor shapes.
 */
import type { UsageLimits } from "@notefig/shared/agent";
import type { HarnessAdapter, UsageUpdate } from "@/modules/harness-adapters";

/** The account limits a `usage_update` carries, if its harness reports any. */
export function limitsFrom(
  adapter: Pick<HarnessAdapter, "limits">,
  update: UsageUpdate,
): UsageLimits | null {
  const meta = update._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  return adapter.limits?.(meta) ?? null;
}
