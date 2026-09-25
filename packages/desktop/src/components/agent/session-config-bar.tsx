/**
 * The composer's session-setting pickers (MET-81): one combobox per
 * switchable option the agent advertises — model, effort — read off the
 * task row's `configOptions` and switched through the `agents` facade.
 * Only the model and effort categories are shown yet; the rest (modes,
 * Fast mode) are folded and tracked like these but deliberately parked.
 * Renders nothing for a harness that advertises no options and for a
 * restored (not yet revived) row, so it never shows values from a previous
 * run.
 *
 * A picker is a popover over a cmdk list: long model catalogues (OpenCode
 * lists every provider's models) get a filter box at the top; short lists
 * (an effort level) stay a plain menu.
 */
import { useState } from "react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check } from "lucide-react";
import type {
  SessionConfigSelect,
  SessionConfigSelectOption,
} from "@notefig/shared/agent";
import type { PromptEditorHandle } from "@notefig/widgets";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@notefig/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@notefig/ui/popover";
import { agents } from "@/agent/agents";
import { useTaskRow } from "@/entities/agents";

/** Model first, effort second. */
const CATEGORY_ORDER: readonly string[] = ["model", "thought_level"];

/** The only categories the toolbar shows for now (see the module comment):
 *  the model and the effort/thinking level. Modes and model_config extras
 *  (Claude's Fast mode) are tracked but parked. */
const VISIBLE_CATEGORIES: readonly string[] = CATEGORY_ORDER;

/** Lists longer than this get the filter box. */
const FILTER_THRESHOLD = 6;

function categoryRank(option: SessionConfigSelect): number {
  const index = CATEGORY_ORDER.indexOf(option.category ?? "");
  return index === -1 ? CATEGORY_ORDER.length : index;
}

export function orderConfigOptions(
  options: readonly SessionConfigSelect[],
): SessionConfigSelect[] {
  return options
    .map((option, index) => ({ option, index }))
    .sort(
      (a, b) =>
        categoryRank(a.option) - categoryRank(b.option) || a.index - b.index,
    )
    .map(({ option }) => option);
}

export function visibleConfigOptions(
  options: readonly SessionConfigSelect[],
): SessionConfigSelect[] {
  return orderConfigOptions(
    options.filter((option) => VISIBLE_CATEGORIES.includes(option.category ?? "")),
  );
}

type ChoiceGroup = { name: string | null; choices: SessionConfigSelectOption[] };

/** Ungrouped and grouped select options as one list of labelled groups. */
function choiceGroups(option: SessionConfigSelect): ChoiceGroup[] {
  const groups: ChoiceGroup[] = [];
  for (const entry of option.options) {
    if ("options" in entry) {
      groups.push({ name: entry.name, choices: entry.options });
    } else {
      const last = groups[groups.length - 1];
      if (last && last.name === null) last.choices.push(entry);
      else groups.push({ name: null, choices: [entry] });
    }
  }
  return groups;
}

/** The display name of the current value — the raw id when the agent moved
 *  to a value it never listed, so the trigger never goes blank. */
export function currentChoiceName(option: SessionConfigSelect): string {
  for (const group of choiceGroups(option)) {
    const match = group.choices.find(
      (choice) => choice.value === option.currentValue,
    );
    if (match) return match.name;
  }
  return option.currentValue;
}

/** Categories whose value reads on its own ("Sonnet 4.5", "High"). */
const SELF_DESCRIBING_CATEGORIES: readonly string[] = ["model", "thought_level"];

/** What the trigger reads: a self-describing value alone; any other option
 *  needs its name or its value is noise ("Off" → "Fast mode: Off"). */
export function triggerLabel(option: SessionConfigSelect): string {
  const value = currentChoiceName(option);
  return SELF_DESCRIBING_CATEGORIES.includes(option.category ?? "")
    ? value
    : `${option.name}: ${value}`;
}

export function SessionConfigBar({
  taskId,
  composerRef,
}: {
  taskId: string;
  /** The composer takes focus back when a menu closes: the pickers are a
   *  detour from typing, not a destination. */
  composerRef: RefObject<PromptEditorHandle>;
}) {
  const row = useTaskRow(taskId);
  const options = visibleConfigOptions(
    row && row.status !== "restored" ? (row.configOptions ?? []) : [],
  );
  if (options.length === 0) return null;
  return (
    <>
      {options.map((option) => (
        <SessionConfigPicker
          key={option.id}
          taskId={taskId}
          option={option}
          composerRef={composerRef}
        />
      ))}
    </>
  );
}

function SessionConfigPicker({
  taskId,
  option,
  composerRef,
}: {
  taskId: string;
  option: SessionConfigSelect;
  composerRef: RefObject<PromptEditorHandle>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const groups = choiceGroups(option);
  const choiceCount = groups.reduce((n, g) => n + g.choices.length, 0);
  const choose = async (value: string) => {
    setOpen(false);
    if (value === option.currentValue) return;
    const result = await agents.task(taskId).setConfigOption(option.id, value);
    if (!result.ok) {
      toast.error(
        t("agentSettingSwitchFailed", { name: option.name, error: result.error }),
      );
    }
  };
  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      {/* Modal (like the dropdown menus), so the composer's focus handling
          can't pull focus out of the open list and dismiss it. */}
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-4 max-w-[8rem] items-center rounded px-1 text-[0.625rem] leading-4 text-muted-foreground hover:bg-accent hover:text-foreground"
          title={option.description ?? option.name}
          aria-label={t("agentChangeSetting", { name: option.name })}
          data-session-config={option.id}
          data-session-config-value={option.currentValue}
        >
          <span className="truncate">{triggerLabel(option)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto min-w-[9rem] max-w-[16rem] p-0"
        onCloseAutoFocus={(event) => {
          // Radix would hand focus back to the trigger; the composer is
          // where the user was going.
          event.preventDefault();
          composerRef.current?.focus();
        }}
      >
        <Command className="text-[0.6875rem]">
          {choiceCount > FILTER_THRESHOLD && (
            <CommandInput
              bare
              className="h-5 border-b px-1.5 text-[0.6875rem]"
              placeholder={t("agentFilterSetting", { name: option.name })}
            />
          )}
          <CommandList className="max-h-[14rem]">
            <CommandEmpty className="py-2 text-center text-[0.625rem] text-muted-foreground">
              {t("agentNoSettingMatches")}
            </CommandEmpty>
            {groups.map((group, index) => (
              <CommandGroup
                key={group.name ?? index}
                heading={group.name ?? undefined}
                className="p-0.5 [&_[cmdk-group-heading]]:px-1.5 [&_[cmdk-group-heading]]:py-0.5 [&_[cmdk-group-heading]]:text-[0.5625rem] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide"
              >
                {group.choices.map((choice) => (
                  <CommandItem
                    key={choice.value}
                    // cmdk filters on `value`; the id keeps two models with
                    // one display name distinct.
                    value={`${choice.name} ${choice.value}`}
                    onSelect={() => void choose(choice.value)}
                    data-session-config-choice={choice.value}
                    className="gap-1 px-1.5 py-0.5 text-[0.6875rem] [&_svg]:size-2.5"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{choice.name}</span>
                      {choice.description && (
                        <span
                          className="truncate text-[0.5625rem] leading-tight text-muted-foreground"
                          title={choice.description}
                        >
                          {choice.description}
                        </span>
                      )}
                    </span>
                    {choice.value === option.currentValue && (
                      <Check className="shrink-0" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
