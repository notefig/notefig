/**
 * Diff blocks in the editor: a code block with a diff (./schema.ts) is drawn
 * as its card (./element.tsx), by the editor's drawn code blocks
 * (../drawn-block/extension.ts), which make it one thing to the selection
 * and say how it is edited. A body Pierre finds no hunks in stays code.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import type { DrawnBlockKind } from "../drawn-block/extension";
import { createDiffBlockElement, WORKSPACE_ATTRIBUTE } from "./element";
import { parseDiffBlock } from "./patch";

/** `workspacePath`: the workspace the document's diff paths are in — the
 *  document wears it, for the cards above and those in its widgets'
 *  responses alike. */
export function diffBlocks({ workspacePath = null }: { workspacePath?: string | null } = {}): DrawnBlockKind<FileDiffMetadata> {
  return {
    name: "diff",
    matches: (node) => node.attrs.diff === true,
    read: (node) => parseDiffBlock(node.attrs.language as string | null, node.textContent),
    draw: (node, diff) => createDiffBlockElement(node.attrs.language as string | null, node.textContent, diff),
    attributes: workspacePath ? { [WORKSPACE_ATTRIBUTE]: workspacePath } : undefined,
  };
}
