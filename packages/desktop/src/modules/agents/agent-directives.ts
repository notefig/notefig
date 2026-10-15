/**
 * The agents' prompt directives (`core.directives`): `@model:<value>` picks
 * the model a prompt's turn runs on, `@skill:<name>` runs one of the
 * harness's commands or skills. What they offer is the session's own, as it
 * last reported it, else its harness's catalog (`core.harnesses`) — what a
 * session would offer before one exists.
 */
import { defineModule } from "@notefig/core";
import {
  directivesModule,
  type DirectiveContext,
  type DirectiveNamespace,
} from "@/modules/directives";
import { agentStoreModule, type AgentStore } from "./agent-collections";
import { harnessesModule, type HarnessesApi } from "./harnesses";
import { settingChoices } from "./session-config";

type Sources = {
  store: Pick<AgentStore, "tasks">;
  harnesses: Pick<HarnessesApi, "collection">;
};

/** What the prompt's session offers: its own reports, else its harness's. */
function offerOf({ store, harnesses }: Sources, ctx: DirectiveContext) {
  const row = ctx.taskId ? store.tasks.get(ctx.taskId) : undefined;
  const catalog = harnesses.collection.get(ctx.harnessId)?.catalog;
  return {
    configOptions: row?.configOptions?.length
      ? row.configOptions
      : (catalog?.configOptions ?? []),
    commands: row?.commands?.length ? row.commands : (catalog?.commands ?? []),
  };
}

/** A session setting as a namespace: its choices, switched to before the
 *  prompt's turn (the last one given wins). */
export function settingNamespace(
  sources: Sources,
  { name, category }: { name: string; category: string },
): DirectiveNamespace {
  return {
    name,
    candidates: (ctx) => {
      const option = offerOf(sources, ctx).configOptions.find(
        (entry) => entry.category === category,
      );
      return option
        ? // Names only: a setting's choices are told apart by name, and
          // their descriptions crowd the menu.
          settingChoices(option).map((choice) => ({ value: choice.value, label: choice.name }))
        : [];
    },
    resolve: (values) => ({ config: [{ category, value: values[values.length - 1] }] }),
  };
}

/** The harness's commands and skills, run with the prompt. */
export function skillNamespace(sources: Sources): DirectiveNamespace {
  return {
    name: "skill",
    candidates: (ctx) =>
      offerOf(sources, ctx).commands.map((command) => ({
        value: command.name,
        label: command.name,
        ...(command.description ? { description: command.description } : {}),
      })),
    resolve: (values) => ({ commands: values.map((name) => ({ name })) }),
  };
}

export const agentDirectivesModule = defineModule({
  name: "agentDirectives",
  needs: [directivesModule, agentStoreModule, harnessesModule],
  boot: (_api, ctx) => {
    const sources = { store: ctx.use("agentStore"), harnesses: ctx.use("harnesses") };
    const directives = ctx.use("directives");
    const off = [
      directives.register(settingNamespace(sources, { name: "model", category: "model" })),
      directives.register(skillNamespace(sources)),
    ];
    return () => off.forEach((unregister) => unregister());
  },
});
