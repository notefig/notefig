/**
 * What each built-in harness reports beyond tokens, as the spike found it
 * (docs/architecture/spikes/acp-token-usage-spike.md): cost on its
 * `usage_update`, account limits in its `_meta`. Views use this to grey out
 * what a harness will never fill, rather than showing an empty chart as if
 * nothing had been spent. A harness not listed (a custom one) is judged by
 * what it has actually sent.
 */
export type UsageReporting = {
  /** Sends a running cost (`usage_update.cost`). */
  cost: boolean;
  /** Sends account limits a reader in `usage-limits.ts` understands. */
  limits: boolean;
};

const KNOWN: Record<string, UsageReporting> = {
  "claude-code": { cost: true, limits: true },
  opencode: { cost: true, limits: false },
  devin: { cost: false, limits: false },
  "gemini-cli": { cost: false, limits: false },
};

/** What `harnessId` reports. `seen` is what its own data shows — a cost or a
 *  limits report already recorded — and counts even where the table says
 *  otherwise, since an adapter update can start sending either. */
export function usageReportingOf(
  harnessId: string,
  seen: Partial<UsageReporting> = {},
): UsageReporting {
  const known = KNOWN[harnessId];
  return {
    cost: !!known?.cost || !!seen.cost,
    limits: !!known?.limits || !!seen.limits,
  };
}
