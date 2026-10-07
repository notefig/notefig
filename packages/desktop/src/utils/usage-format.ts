/** Display formatting for token counts and cost. */
import { costType, type Cost } from "@notefig/shared/agent";

/** 950 · 12.3k · 4.5M */
export function formatTokens(count: number): string {
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) return `${trim(count / 1000)}k`;
  return `${trim(count / 1_000_000)}M`;
}

function trim(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
}

/** $0.34 · $0.0021 · 12.5 credits — money keeps two significant digits
 *  when small; credits are a plain count. */
export function formatCost(money: Cost): string {
  if (costType(money) === "credits") {
    const amount = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return `${amount.format(money.amount)} credits`;
  }
  const digits = money.amount !== 0 && Math.abs(money.amount) < 0.01 ? 4 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: money.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(money.amount);
  } catch {
    // Not an ISO 4217 code: a harness adapter sent something unexpected.
    return `${money.amount.toFixed(digits)} ${money.currency}`;
  }
}
