import { describe, expect, it } from "vitest";
import { createLinearClient } from "./linear";

function graphql(handler: (query: string, variables: Record<string, unknown>) => unknown) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const fetch = (async (_url: string, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body));
    calls.push({ query, variables });
    return Response.json({ data: handler(query, variables) });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const team = {
  teams: {
    nodes: [{ id: "team-met", states: { nodes: [{ id: "s-triage", type: "triage" }] } }],
  },
};

describe("createLinearClient context", () => {
  it("finds a label and a project past the first page", async () => {
    const { fetch } = graphql((query, { after }) => {
      if (query.includes("IntakeTeam")) return team;
      if (query.includes("IntakeLabels")) {
        return after === "labels-2"
          ? { issueLabels: { nodes: [{ id: "l-late", name: "agent:build", team: null }], pageInfo: { hasNextPage: false, endCursor: null } } }
          : { issueLabels: { nodes: [{ id: "l-bug", name: "Bug", team: { id: "team-met" } }], pageInfo: { hasNextPage: true, endCursor: "labels-2" } } };
      }
      return after === "projects-2"
        ? { projects: { nodes: [{ id: "p-ga", name: "GA roadmap" }], pageInfo: { hasNextPage: false, endCursor: null } } }
        : { projects: { nodes: [{ id: "p-old", name: "Old" }], pageInfo: { hasNextPage: true, endCursor: "projects-2" } } };
    });
    const context = await createLinearClient({ apiKey: "key", teamKey: "MET", fetch }).context();
    expect(context.labelId("Bug")).toBe("l-bug");
    expect(context.labelId("agent:build")).toBe("l-late");
    expect(context.projectId("GA roadmap")).toBe("p-ga");
    expect(context.triageStateId()).toBe("s-triage");
  });

  it("ignores another team's label of the same name", async () => {
    const { fetch } = graphql((query) => {
      if (query.includes("IntakeTeam")) return team;
      if (query.includes("IntakeLabels")) {
        return { issueLabels: { nodes: [{ id: "l-other", name: "Bug", team: { id: "team-other" } }], pageInfo: { hasNextPage: false, endCursor: null } } };
      }
      return { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } };
    });
    const context = await createLinearClient({ apiKey: "key", teamKey: "MET", fetch }).context();
    expect(() => context.labelId("Bug")).toThrow(/not found/);
  });
});
