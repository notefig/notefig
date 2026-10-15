/**
 * The seam between the mention suggestion plugin and React.
 *
 * The plugin is registered when the document's editor is constructed —
 * outside React, with no host in scope (rule 3: the renderer half takes
 * nothing from the application). But the suggestion needs two things that
 * only the app can provide: the workspace file search behind its results,
 * and a place to render its popup.
 *
 * So the plugin's options are stable forwarders that read this registry at
 * call time, and `PromptMentionMenu` — a React component mounted next to
 * the editor, inside the host provider — registers the real service on
 * mount. The menu is mounted for every document on screen — the app's
 * page-link suggestion forwards here too, not just the draft-scoped
 * mention — so the registry is populated whenever it is consulted.
 *
 * Keyed by document path, like the app's own editor instances: one live
 * editor per file, and its menu outlives nothing.
 */
import type { SuggestionProps, SuggestionKeyDownProps } from "@tiptap/suggestion";
import type { MentionRow } from "./mention-suggestion";

export interface MentionService {
  /** True while the popup is showing rows. The composer's key map defers to
   *  it: an open suggestion owns Arrows/Enter/Tab/Escape, but an active
   *  suggestion with no matches must not eat them. */
  hasResults(): boolean;
  /** The search behind the popup's rows: directives (for the session the
   *  caret's widget is bound to, if any) and workspace files, or files
   *  alone. */
  search(
    query: string,
    options?: { directives?: boolean; taskId?: string | null },
  ): Promise<MentionRow[]> | MentionRow[];
  onStart(props: SuggestionProps<MentionRow>): void;
  onUpdate(props: SuggestionProps<MentionRow>): void;
  onKeyDown(props: SuggestionKeyDownProps): boolean;
  onExit(): void;
}

const services = new Map<string, MentionService>();

/** @returns the unregistration, for the menu's effect cleanup. */
export function registerMentionService(
  documentPath: string,
  service: MentionService,
): () => void {
  services.set(documentPath, service);
  return () => {
    if (services.get(documentPath) === service) services.delete(documentPath);
  };
}

export function getMentionService(
  documentPath: string,
): MentionService | undefined {
  return services.get(documentPath);
}

/** Whether the document's mention popup is currently claiming the keyboard. */
export function mentionPopupHasResults(documentPath: string): boolean {
  return services.get(documentPath)?.hasResults() ?? false;
}

/** A document suggestion's menu, driven through the registry: the plugin
 *  was built outside React, so it reaches the live menu at call time. */
export function documentMenu(documentPath: string) {
  return () => ({
    onStart: (props: SuggestionProps<MentionRow>) => services.get(documentPath)?.onStart(props),
    onUpdate: (props: SuggestionProps<MentionRow>) => services.get(documentPath)?.onUpdate(props),
    onKeyDown: (props: SuggestionKeyDownProps) =>
      services.get(documentPath)?.onKeyDown(props) ?? false,
    onExit: () => services.get(documentPath)?.onExit(),
  });
}
