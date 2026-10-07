/**
 * Reads a harness's account limits (rate-limit windows, plan utilization)
 * off what it sends, into the harness-neutral `UsageLimits`. ACP has no
 * field for this; each harness that reports limits does so in its own
 * `_meta`, so each gets a reader here and nothing past this file knows the
 * vendor shapes. Add a harness by adding a reader.
 */
import type {
  UsageLimitStatus,
  UsageLimitWindow,
  UsageLimits,
} from "@notefig/shared/agent";
import type { UsageUpdate } from "./turn-usage";

type Meta = Record<string, unknown>;

type LimitsReader = (meta: Meta) => UsageLimits | null;

const HOUR_MS = 3_600_000;

function isRecord(value: unknown): value is Meta {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// ─── Claude (`_claude/rateLimit`, on usage_update) ──────────────────────────
//
// { status: "allowed" | "allowed_warning" | "rejected", resetsAt (s),
//   rateLimitType, isUsingOverage, overageStatus,
//   unifiedWindows: { five_hour: { utilization, resetsAt (s) }, seven_day, … } }

const CLAUDE_WINDOW_DURATIONS: Record<string, number> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * 24 * HOUR_MS,
  seven_day_opus: 7 * 24 * HOUR_MS,
  seven_day_sonnet: 7 * 24 * HOUR_MS,
  seven_day_overage_included: 7 * 24 * HOUR_MS,
};

function claudeStatus(status: unknown): UsageLimitStatus {
  if (status === "allowed") return "ok";
  if (status === "allowed_warning") return "warning";
  if (status === "rejected") return "blocked";
  return "unknown";
}

const readClaudeLimits: LimitsReader = (meta) => {
  const rateLimit = meta["_claude/rateLimit"];
  if (!isRecord(rateLimit)) return null;
  const windows: UsageLimitWindow[] = [];
  const unified = isRecord(rateLimit.unifiedWindows) ? rateLimit.unifiedWindows : {};
  for (const [id, window] of Object.entries(unified)) {
    if (!isRecord(window)) continue;
    const utilization = finite(window.utilization);
    if (utilization === null) continue;
    const resetsAt = finite(window.resetsAt);
    windows.push({
      id,
      utilization,
      resetsAt: resetsAt === null ? null : resetsAt * 1000,
      durationMs: CLAUDE_WINDOW_DURATIONS[id] ?? null,
    });
  }
  return {
    status: claudeStatus(rateLimit.status),
    windows,
    usingOverage:
      typeof rateLimit.isUsingOverage === "boolean" ? rateLimit.isUsingOverage : null,
  };
};

const READERS: LimitsReader[] = [readClaudeLimits];

/** The account limits a `usage_update` carries, if its harness reports any. */
export function limitsFrom(update: UsageUpdate): UsageLimits | null {
  const meta = update._meta;
  if (!isRecord(meta)) return null;
  for (const read of READERS) {
    const limits = read(meta);
    if (limits) return limits;
  }
  return null;
}
