/**
 * Dictation from React: the hold key's name for the composers'
 * placeholders ("… or hold right ⌥ to talk"), while dictation is on.
 */
import { useCore } from "@notefig/core/react";
import { useAppSettings } from "@/hooks/use-app-settings";
import { holdKeyLabel } from "./dictation";

export function useDictationKey(): string | null {
  // Absent in roots without the dictation module (the marketing site).
  const { dictation } = useCore() as { dictation?: ReturnType<typeof useCore>["dictation"] };
  const { settings } = useAppSettings();
  if (!dictation || !settings.dictationEnabled) return null;
  return holdKeyLabel(dictation.holdKey);
}
