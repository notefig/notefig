/**
 * The contract between the dictation service and the editors it types
 * into: an editor offers itself as a target (`DictationHost.attach`), and
 * each dictation into it is an insertion. `@notefig/widgets`' Tiptap
 * extension is the implementation; this package has no editor of its own.
 */

/** One dictation into one editor, from key down to commit or cancel. */
export interface DictationInsertion {
  /** The words heard so far: `settled` phrases won't change; `live` is the
   *  phrase still being spoken, re-heard as it goes. */
  preview(settled: string, live: string): void;
  /** Insert the final text where the dictation began. */
  commit(text: string): void;
  /** Drop the ghost; nothing is inserted. */
  cancel(): void;
}

/** An editor that can take dictation. */
export interface DictationTarget {
  hasFocus(): boolean;
  /** Starts a dictation at the selection; null when the editor isn't editable. */
  begin(): DictationInsertion | null;
}

/** What the app hands the extension: where targets register, and the
 *  microphone's state for the wave. */
export interface DictationHost {
  attach(target: DictationTarget): () => void;
  /** Its level now, 0–1. */
  level(): number;
  /** Whether sound is reaching it yet: a mic takes a moment to open, and
   *  until then nothing said is heard. */
  hearing(): boolean;
}

/**
 * Fits dictated `text` between what's before and after the caret in its
 * block: a space on either side where words would otherwise touch, a
 * lowercase first word mid-sentence, no closing period when the sentence
 * carries on after it.
 */
export function fitDictation(before: string, after: string, text: string): string {
  let fitted = text.trim();
  if (!fitted) return "";
  const midSentence = before.trim() !== "" && !/[.!?:]\s*$/.test(before);
  if (midSentence && /^[A-Z][a-z]/.test(fitted) && !/^I\b/.test(fitted)) {
    fitted = fitted[0].toLowerCase() + fitted.slice(1);
  }
  if (/^\s*[a-z]/.test(after)) fitted = fitted.replace(/\.$/, "");
  if (before !== "" && !/\s$/.test(before)) fitted = ` ${fitted}`;
  if (/^[\p{L}\p{N}]/u.test(after)) fitted = `${fitted} `;
  return fitted;
}
