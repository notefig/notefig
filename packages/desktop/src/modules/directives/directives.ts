/**
 * Prompt directives — `@<namespace>:<value>` in a composer (`@model:opus`,
 * `@skill:review`). They are picked from the "@" menu and kept as chips like
 * a file mention, and like a file mention they are only text until the
 * prompt is sent: then each namespace turns the values it was given into
 * what the prompt is sent with (a setting to switch to, a command to run),
 * and the tokens leave the text.
 *
 * Namespaces register here, from the modules that own what they offer; the
 * composers, the widget host and this registry know none of them. The "@"
 * suggestion (`@notefig/widgets`) searches what they offer, as sources;
 * this is what they do when a prompt is sent.
 */
import { defineModule } from "@notefig/core";
import {
  findDirective,
  segmentMentions,
  type DirectiveCandidate,
  type DirectiveSource,
} from "@notefig/widgets";
import type { PromptExtras } from "@notefig/shared/agent";

/** Where a directive is being picked or sent. */
export interface DirectiveContext {
  workspacePath: string;
  /** The session the prompt goes to, if there is one yet. */
  taskId: string | null;
  /** That session's harness, else the one a new session would use. */
  harnessId: string;
}

/** What directives ask a prompt to be sent with. */
export type DirectiveExtras = Pick<PromptExtras, "commands" | "config">;

/** A namespace as registered: a suggestion source given its context, and
 *  what its values do to a prompt. */
export interface DirectiveNamespace extends Pick<DirectiveSource, "name"> {
  /** What can be picked now, read from live rows. */
  candidates(ctx: DirectiveContext): DirectiveCandidate[];
  /** What a prompt is sent with for this namespace's values, in order. */
  resolve(values: string[], ctx: DirectiveContext): DirectiveExtras;
}

export interface DirectivesApi {
  register(namespace: DirectiveNamespace): () => void;
  /** Every namespace as the "@" suggestion's source, offering what it does
   *  in this context. */
  sources(ctx: DirectiveContext): DirectiveSource[];
  /**
   * A finished prompt without its directives, and what they ask it to be
   * sent with. Tokens that name nothing stay as text. A prompt that was
   * nothing but settings keeps its text, so there is something to send.
   */
  resolve(text: string, ctx: DirectiveContext): { text: string; extras: DirectiveExtras };
}

/** `text` without the mentions `isDirective` accepts, and those mentions
 *  in order. A dropped token's following space goes with it, so
 *  "a @x:y b" reads "a b". */
function stripDirectives(text: string, isDirective: (token: string) => boolean) {
  const tokens: string[] = [];
  let stripped = "";
  let dropSpace = false;
  for (const segment of segmentMentions(text, isDirective)) {
    if (segment.type === "mention") {
      tokens.push(segment.value);
      dropSpace = stripped === "" || /\s$/.test(stripped);
      continue;
    }
    stripped += dropSpace ? segment.value.replace(/^ /, "") : segment.value;
    dropSpace = false;
  }
  return { stripped: stripped.trim(), tokens };
}

/** Every namespace's extras as one: lists concatenated, in order. */
function mergeExtras(all: DirectiveExtras[]): DirectiveExtras {
  const merged: DirectiveExtras = {};
  for (const { commands, config } of all) {
    if (commands) merged.commands = [...(merged.commands ?? []), ...commands];
    if (config) merged.config = [...(merged.config ?? []), ...config];
  }
  return merged;
}

export function createDirectives(): DirectivesApi {
  const namespaces = new Map<string, DirectiveNamespace>();
  const sources = (ctx: DirectiveContext): DirectiveSource[] =>
    [...namespaces.values()].map(({ name, candidates }) => ({
      name,
      candidates: () => candidates(ctx),
    }));

  return {
    register(namespace) {
      namespaces.set(namespace.name, namespace);
      return () => {
        if (namespaces.get(namespace.name) === namespace) namespaces.delete(namespace.name);
      };
    },
    sources,
    resolve(text, ctx) {
      const offered = sources(ctx);
      const { stripped, tokens } = stripDirectives(text, (token) => !!findDirective(offered, token));
      const values = new Map<DirectiveNamespace, string[]>();
      for (const token of tokens) {
        const { source, value } = findDirective(offered, token)!;
        const namespace = namespaces.get(source.name)!;
        values.set(namespace, [...(values.get(namespace) ?? []), value]);
      }
      const extras = mergeExtras(
        [...values].map(([namespace, used]) => namespace.resolve(used, ctx)),
      );
      return { text: stripped || extras.commands ? stripped : text, extras };
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    directives: DirectivesApi;
  }
}

export const directivesModule = defineModule({
  name: "directives",
  register: () => createDirectives(),
});
