import type { LinearClient, LinearContext, StateType } from "./linear";

const STATES: Record<string, StateType> = {
  "state-triage": "triage",
  "state-backlog": "backlog",
  "state-todo": "unstarted",
  "state-done": "completed",
  "state-canceled": "canceled",
  "state-duplicate": "duplicate",
};

const LABELS: Record<string, string> = {
  Feedback: "label-feedback",
  Bug: "label-bug",
  Feature: "label-feature",
  "agent:build": "label-agent-build",
};

const PROJECTS: Record<string, string> = { "GA roadmap": "project-ga" };

export type LinearCall =
  | { op: "create"; input: Parameters<LinearClient["createIssue"]>[0] }
  | { op: "update"; id: string; input: Parameters<LinearClient["updateIssue"]>[1] }
  | { op: "comment"; issueId: string; body: string };

/** A LinearClient over a fixed MET-like team that records every write. */
export function fakeLinear(options: { failCreate?: boolean } = {}) {
  const calls: LinearCall[] = [];
  const context: LinearContext = {
    teamId: "team-met",
    triageStateId: () => "state-triage",
    stateType: (id) => STATES[id],
    labelId(name) {
      const id = LABELS[name];
      if (!id) throw new Error(`no label ${name}`);
      return id;
    },
    hasLabel: (ids, name) => ids.includes(LABELS[name] ?? ""),
    projectId(name) {
      const id = PROJECTS[name];
      if (!id) throw new Error(`no project ${name}`);
      return id;
    },
  };
  const client: LinearClient = {
    context: async () => context,
    async createIssue(input) {
      if (options.failCreate) throw new Error("Linear is down");
      calls.push({ op: "create", input });
      return { id: `issue-${calls.length}`, identifier: `MET-${calls.length}` };
    },
    async updateIssue(id, input) {
      calls.push({ op: "update", id, input });
    },
    async comment(issueId, body) {
      calls.push({ op: "comment", issueId, body });
    },
  };
  return { client, calls };
}
