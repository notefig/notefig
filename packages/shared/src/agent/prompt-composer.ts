import type { ContentBlock } from "./acp-types";

/**
 * Builds the ACP `ContentBlock[]` for a prompt. One shared function so the
 * panel, the floating prompt (Stage 4), blob continuations (Stage 2), and
 * tests all compose identically. Capability-gated: `embeddedContext` degrades
 * to inline fenced text when the harness doesn't advertise the capability
 * (per the Stage 0 capability matrix).
 */
export interface PromptContextPart {
  kind: "resource_link" | "embedded";
  path: string;
  content?: string;
}

export interface ComposePromptInput {
  text: string;
  contextParts?: PromptContextPart[];
  capabilities: { embeddedContext: boolean };
}

export function composePrompt(input: ComposePromptInput): ContentBlock[] {
  const blocks: ContentBlock[] = [{ type: "text", text: input.text }];

  for (const part of input.contextParts ?? []) {
    if (part.kind === "resource_link") {
      blocks.push({
        type: "resource_link",
        uri: part.path,
        name: part.path,
      });
      continue;
    }

    // kind === "embedded"
    if (input.capabilities.embeddedContext) {
      blocks.push({
        type: "resource",
        resource: {
          uri: part.path,
          text: part.content ?? "",
        },
      });
    } else {
      // Degrade path: no embeddedContext capability, inline as fenced text.
      blocks.push({
        type: "text",
        text: `\n\n\`\`\`${part.path}\n${part.content ?? ""}\n\`\`\`\n`,
      });
    }
  }

  return blocks;
}
