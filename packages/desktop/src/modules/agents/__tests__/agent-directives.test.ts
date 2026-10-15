import { describe, it, expect } from "vitest";
import type { AgentTaskRow, SessionConfigSelect } from "@notefig/shared/agent";
import type { HarnessCatalog } from "@/modules/harness-adapters";
import { settingNamespace, skillNamespace } from "../agent-directives";

const models = (...values: string[]): SessionConfigSelect => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: values[0],
  options: values.map((value) => ({ value, name: value.toUpperCase() })),
});

function sources(row?: Partial<AgentTaskRow>, catalog?: HarnessCatalog) {
  return {
    store: { tasks: { get: (id: string) => (id === "task_1" ? (row as AgentTaskRow) : undefined) } },
    harnesses: {
      collection: {
        get: (id: string) => (id === "claude-code" && catalog ? { id, createdAt: 0, catalog } : undefined),
      },
    },
  } as never;
}

const live = { workspacePath: "/ws", taskId: "task_1", harnessId: "claude-code" };
const none = { ...live, taskId: null };

describe("the agents' directives", () => {
  const catalog: HarnessCatalog = {
    configOptions: [models("opus", "sonnet")],
    commands: [{ name: "init", description: "Set up" }],
  };

  it("offers the session's own models and skills, else its harness's", () => {
    const own = sources(
      { configOptions: [models("haiku")], commands: [{ name: "review", description: "" }] },
      catalog,
    );
    const model = settingNamespace(own, { name: "model", category: "model" });

    expect(model.candidates(live)).toEqual([{ value: "haiku", label: "HAIKU" }]);
    expect(skillNamespace(own).candidates(live).map((c) => c.value)).toEqual(["review"]);
    expect(model.candidates(none).map((c) => c.value)).toEqual(["opus", "sonnet"]);
    expect(skillNamespace(own).candidates(none)).toEqual([
      { value: "init", label: "init", description: "Set up" },
    ]);
  });

  it("lists models by name alone, without their descriptions", () => {
    const described = { ...models("opus"), options: [{ value: "opus", name: "Opus", description: "Most capable" }] };
    const model = settingNamespace(sources({ configOptions: [described] }), { name: "model", category: "model" });
    expect(model.candidates(live)).toEqual([{ value: "opus", label: "Opus" }]);
  });

  it("offers nothing a harness hasn't reported", () => {
    const model = settingNamespace(sources(), { name: "model", category: "model" });
    expect(model.candidates(none)).toEqual([]);
    expect(skillNamespace(sources()).candidates(none)).toEqual([]);
  });

  it("asks for the last model given, and every skill in order", () => {
    const model = settingNamespace(sources(), { name: "model", category: "model" });

    expect(model.resolve(["opus", "sonnet"], live)).toEqual({
      config: [{ category: "model", value: "sonnet" }],
    });
    expect(skillNamespace(sources()).resolve(["review", "init"], live)).toEqual({
      commands: [{ name: "review" }, { name: "init" }],
    });
  });
});
