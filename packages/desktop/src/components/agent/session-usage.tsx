/**
 * Usage readouts in the chat: the session's running total in the composer
 * footer, and what one turn spent under its prompt. Both read rows the
 * agent subsystem writes — the task row's `usage` (durable) and a turn's
 * `usage` (in memory, gone after a relaunch).
 */
import type { ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Popover, PopoverContent, PopoverTrigger } from "@notefig/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@notefig/ui/tooltip";
import type { PromptEditorHandle } from "@notefig/widgets";
import {
  totalTokens,
  type SessionUsage,
  type TurnUsage,
  type Usage,
} from "@notefig/shared/agent";
import { formatCost, formatTokens } from "@/utils/usage-format";

/** Composer footer: tokens in context against the window's limit; a click
 *  opens what the session has spent. Before the harness reports a context
 *  window, the session's token total stands in. */
export function SessionUsageChip({
  usage,
  composerRef,
}: {
  usage: SessionUsage | undefined;
  /** Focus goes back here when the popover closes. */
  composerRef: RefObject<PromptEditorHandle>;
}) {
  const { t } = useTranslation();
  if (!usage || (usage.turns === 0 && !usage.context)) return null;
  const label = usage.context
    ? `${formatTokens(usage.context.used)} / ${formatTokens(usage.context.size)}`
    : formatTokens(totalTokens(usage.total.tokens));
  return (
    <Popover modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-4 items-center rounded px-1 text-[0.5625rem] leading-4 tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("usageSessionTitle")}
          data-testid="session-usage"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-auto min-w-[10rem] max-w-[18rem] p-2 text-[0.6875rem]"
        data-testid="session-usage-details"
        onCloseAutoFocus={(event) => {
          // Radix would hand focus back to the trigger; the composer is
          // where the user was going.
          event.preventDefault();
          composerRef.current?.focus();
        }}
      >
        <StatGrid>
          {usage.context && (
            <Stat label={t("usageContext")}>
              {formatTokens(usage.context.used)}
              <span className="font-normal text-muted-foreground">
                {" / "}
                {formatTokens(usage.context.size)}
              </span>
            </Stat>
          )}
          {usage.turns > 0 && <TokenStats usage={usage.total} withCost />}
          {usage.byModel.length > 1 && (
            <>
              <Divider />
              {usage.byModel.map((row) => (
                <Stat
                  key={row.model ?? "unknown"}
                  label={row.model ?? t("usageUnknownModel")}
                >
                  {formatTokens(totalTokens(row.usage.tokens))}
                </Stat>
              ))}
            </>
          )}
        </StatGrid>
      </PopoverContent>
    </Popover>
  );
}

/** Under a prompt: what its turn spent, in tokens. Live turns only —
 *  replayed ones carry no usage, so nothing renders rather than a wrong zero. */
export function TurnUsageLabel({ usage }: { usage: TurnUsage | null | undefined }) {
  const { t } = useTranslation();
  if (!usage) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default text-[0.625rem] tabular-nums text-muted-foreground">
          {formatTokens(totalTokens(usage.total.tokens))} {t("usageTokensUnit")}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="p-2 text-[0.6875rem]">
        <StatGrid>
          <TokenStats usage={usage.total} />
        </StatGrid>
      </TooltipContent>
    </Tooltip>
  );
}

/** Label/value rows: quiet labels on the left, the numbers set apart on the
 *  right (heavier, foreground, aligned digits) so they scan as a column. */
function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_auto] items-baseline gap-x-4 gap-y-0.5">
      {children}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="max-w-[10rem] truncate text-[0.625rem] text-muted-foreground">
        {label}
      </span>
      <span className="text-end font-medium tabular-nums text-foreground">
        {children}
      </span>
    </>
  );
}

function Divider() {
  return <div className="col-span-2 my-0.5 border-t border-border" />;
}

function TokenStats({ usage, withCost = false }: { usage: Usage; withCost?: boolean }) {
  const { t } = useTranslation();
  const { tokens } = usage;
  return (
    <>
      <Stat label={t("usageInput")}>{formatTokens(tokens.input)}</Stat>
      <Stat label={t("usageOutput")}>{formatTokens(tokens.output + tokens.thought)}</Stat>
      {(tokens.cacheRead > 0 || tokens.cacheWrite > 0) && (
        <>
          <Stat label={t("usageCacheRead")}>{formatTokens(tokens.cacheRead)}</Stat>
          <Stat label={t("usageCacheWrite")}>{formatTokens(tokens.cacheWrite)}</Stat>
        </>
      )}
      {withCost && usage.cost && (
        <>
          <Divider />
          <Stat label={t("usageCost")}>{formatCost(usage.cost)}</Stat>
        </>
      )}
    </>
  );
}
