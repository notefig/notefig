import type { IssueDetails, LinearClient, LinearContext, StateType } from "./linear";

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
  | { op: "comment"; issueId: string; body: string }
  | { op: "attach"; issueId: string; link: Parameters<LinearClient["attach"]>[1] };

/**
 * A LinearClient over a fixed MET-like team that records every write.
 * `issues` overrides what `issue(id)` reads; by default every issue is an
 * open MET issue named after its id.
 */
export function fakeLinear(
  options: { failCreate?: boolean; issues?: Record<string, Partial<IssueDetails>> } = {},
) {
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
    async issue(id) {
      return {
        id,
        identifier: `MET-${id}`,
        title: `Title of ${id}`,
        description: `Description of ${id}`,
        stateType: "unstarted",
        ...options.issues?.[id],
      };
    },
    async attach(issueId, link) {
      calls.push({ op: "attach", issueId, link });
    },
  };
  return { client, calls };
}
