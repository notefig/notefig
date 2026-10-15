import type { SessionConfigSelect } from "@notefig/shared/agent";

/** A select setting's choices as one flat list, its groups opened up. */
export function settingChoices(option: SessionConfigSelect) {
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}
