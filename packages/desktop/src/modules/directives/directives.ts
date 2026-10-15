/**
 * Prompt directives — `@<namespace>:<value>` in a composer (`@model:opus`,
 * `@skill:review`). They are picked from the "@" menu and kept as chips like
 * a file mention, and like a file mention they are only text until the
 * prompt is sent: then each namespace turns the values it was given into
 * what the prompt is sent with (a setting to switch to, a command to run),
 * and the tokens leave the text.
 *
 * Namespaces register here, from the modules that own what they offer; the
 * composers, the widget host and this registry know none of them.
 */
import { defineModule } from "@notefig/core";
import { segmentMentions } from "@notefig/widgets";
import type { PromptExtras } from "@notefig/shared/agent";

/** Where a directive is being picked or sent. */
export interface DirectiveContext {
  workspacePath: string;
  /** The session the prompt goes to, if there is one yet. */
  taskId: string | null;
  /** That session's harness, else the one a new session would use. */
  harnessId: string;
}

export interface DirectiveCandidate {
  value: string;
  label: string;
  description?: string;
}

/** What directives ask a prompt to be sent with. */
export type DirectiveExtras = Pick<PromptExtras, "commands" | "config">;

export interface DirectiveNamespace {
  /** The token's namespace: `model` is `@model:<value>`. */
  name: string;
  /** What can be picked now, read from live rows. */
  candidates(ctx: DirectiveContext): DirectiveCandidate[];
  /** What a prompt is sent with for this namespace's values, in order. */
  resolve(values: string[], ctx: DirectiveContext): DirectiveExtras;
}

/** A row of the "@" menu: a namespace to type into (no value), or one of
 *  its candidates. */
export type DirectiveMatch = { namespace: string } & (
  | { value: null; label: string; description?: undefined }
  | DirectiveCandidate
);

export interface DirectivesApi {
  register(namespace: DirectiveNamespace): () => void;
  /**
   * The menu's rows for what follows an "@", members first-class like
   * files: `<namespace>:<query>` lists that namespace's members it matches;
   * a query that starts a namespace's name lists its members (`@mo` —
   * every model); any other lists the members it matches (`@son` — Sonnet).
   * A bare "@" lists the namespaces, as a hint of what can follow.
   */
  search(query: string, ctx: DirectiveContext, limit: number): DirectiveMatch[];
  /** Whether `<namespace>:<value>` names a candidate now. */
  isDirective(token: string, ctx: DirectiveContext): boolean;
  /**
   * A finished prompt without its directives, and what they ask it to be
   * sent with. Tokens that name nothing stay as text. A prompt that was
   * nothing but settings keeps its text, so there is something to send.
   */
  resolve(text: string, ctx: DirectiveContext): { text: string; extras: DirectiveExtras };
}

/** Prefix matches first, then substring ones, on value or label. */
function rank(candidates: DirectiveCandidate[], query: string): DirectiveCandidate[] {
  const needle = query.toLowerCase();
  const at = (candidate: DirectiveCandidate) =>
    Math.min(
      ...[candidate.value, candidate.label].map((text) => {
        const index = text.toLowerCase().indexOf(needle);
        return index === -1 ? Infinity : index === 0 ? 0 : 1;
      }),
    );
  return candidates
    .map((candidate) => ({ candidate, at: at(candidate) }))
    .filter(({ at }) => at !== Infinity)
    .sort((a, b) => a.at - b.at)
    .map(({ candidate }) => candidate);
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

  /** The namespace and value of `<namespace>:<value>`, if it names one. */
  const parse = (token: string) => {
    const colon = token.indexOf(":");
    const namespace = colon > 0 ? namespaces.get(token.slice(0, colon)) : undefined;
    return namespace ? { namespace, value: token.slice(colon + 1) } : null;
  };

  const isDirective = (token: string, ctx: DirectiveContext) => {
    const parsed = parse(token);
    return (
      !!parsed &&
      parsed.namespace.candidates(ctx).some((candidate) => candidate.value === parsed.value)
    );
  };

  return {
    register(namespace) {
      namespaces.set(namespace.name, namespace);
      return () => {
        if (namespaces.get(namespace.name) === namespace) namespaces.delete(namespace.name);
      };
    },
    search(query, ctx, limit) {
      const parsed = parse(query);
      if (parsed) {
        return rank(parsed.namespace.candidates(ctx), parsed.value)
          .slice(0, limit)
          .map((candidate) => ({ namespace: parsed.namespace.name, ...candidate }));
      }
      const all = [...namespaces.values()];
      if (!query) {
        return all
          .map(({ name }) => ({ namespace: name, value: null, label: `${name}:` }) as const)
          .slice(0, limit);
      }
      const named = query.toLowerCase();
      return all
        .flatMap(({ name, candidates }) =>
          (name.startsWith(named) ? candidates(ctx) : rank(candidates(ctx), query)).map(
            (candidate) => ({ namespace: name, ...candidate }),
          ),
        )
        .slice(0, limit);
    },
    isDirective,
    resolve(text, ctx) {
      const { stripped, tokens } = stripDirectives(text, (token) => isDirective(token, ctx));
      const values = new Map<DirectiveNamespace, string[]>();
      for (const token of tokens) {
        const { namespace, value } = parse(token)!;
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
