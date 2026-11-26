/**
 * Mermaid blocks in the editor: a ```mermaid code block is drawn as its
 * diagram (./element.tsx), by the editor's drawn code blocks
 * (../drawn-block/extension.ts), which make it one thing to the selection
 * and say how it is edited. An empty one stays code, to be written.
 */
import type { DrawnBlockKind } from "../drawn-block/extension";
import { createMermaidBlockElement } from "./element";
import { MERMAID_LANGUAGE } from "./syntax";

export const mermaidBlocks: DrawnBlockKind<string> = {
  name: "mermaid",
  matches: (node) => node.attrs.language === MERMAID_LANGUAGE && node.attrs.diff !== true,
  read: (node) => (node.textContent.trim() ? node.textContent : null),
  draw: (_node, source) => createMermaidBlockElement(source),
};
