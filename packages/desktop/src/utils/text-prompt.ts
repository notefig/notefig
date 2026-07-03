import type { TextPromptOptions } from "@/adapters/platform-adapter.interface";

export const TEXT_PROMPT_EVENT = "request-text-prompt";

export interface TextPromptRequestDetail extends TextPromptOptions {
  callback: (value: string | null) => void;
}

/**
 * Bridge between platform adapters and the in-app <TextPromptDialog />.
 * Dispatches a request event and resolves with the user's answer
 * (null when cancelled). The dialog is mounted once in App.
 */
export function requestTextPrompt(
  options: TextPromptOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    const detail: TextPromptRequestDetail = { ...options, callback: resolve };
    window.dispatchEvent(new CustomEvent(TEXT_PROMPT_EVENT, { detail }));
  });
}
