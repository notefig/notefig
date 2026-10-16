/**
 * The few Linear GraphQL calls the intake service makes, with the team's
 * ids (Triage state, labels, projects) looked up by name and cached for a
 * few minutes, so configuration is names in workflow definitions rather
 * than ids in secrets.
 */

const ENDPOINT = "https://api.linear.app/graphql";
const CONTEXT_TTL_MS = 5 * 60_000;

export type StateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled"
  | "duplicate";

export interface LinearContext {
  teamId: string;
  /** Throws when the team has Triage turned off. */
  triageStateId(): string;
  stateType(stateId: string): StateType | undefined;
  /** Throws when no label of that name is usable in the team. */
  labelId(name: string): string;
  hasLabel(labelIds: readonly string[], name: string): boolean;
  /** Throws when no project has that name. */
  projectId(name: string): string;
}

export interface CreatedIssue {
  id: string;
  identifier: string;
}

export interface IssueDetails extends CreatedIssue {
  title: string;
  description: string;
  stateType: StateType;
}

export interface LinearClient {
  context(): Promise<LinearContext>;
  createIssue(input: {
    teamId: string;
    stateId: string;
    title: string;
    description: string;
    labelIds: string[];
  }): Promise<CreatedIssue>;
  updateIssue(id: string, input: { addedLabelIds?: string[]; projectId?: string }): Promise<void>;
  comment(issueId: string, body: string): Promise<void>;
  issue(id: string): Promise<IssueDetails>;
  /** A link in the issue's sidebar. Attachments stay in Linear. */
  attach(issueId: string, link: { url: string; title: string; subtitle?: string }): Promise<void>;
}

export interface LinearClientOptions {
  apiKey: string;
  teamKey: string;
  fetch?: typeof fetch;
  now?: () => number;
}

interface ContextData {
  teams: { nodes: { id: string; states: { nodes: { id: string; type: StateType }[] } }[] };
  issueLabels: { nodes: { id: string; name: string; team: { id: string } | null }[] };
  projects: { nodes: { id: string; name: string }[] };
}

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

const TEAM_QUERY = `
  query IntakeTeam($teamKey: String!) {
    teams(filter: { key: { eq: $teamKey } }) {
      nodes { id states { nodes { id type } } }
    }
  }`;

const LABELS_QUERY = `
  query IntakeLabels($after: String) {
    issueLabels(first: 250, after: $after) {
      nodes { id name team { id } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

const PROJECTS_QUERY = `
  query IntakeProjects($after: String) {
    projects(first: 250, after: $after) {
      nodes { id name }
      pageInfo { hasNextPage endCursor }
    }
  }`;

function buildContext(teamKey: string, data: ContextData): LinearContext {
  const team = data.teams.nodes[0];
  if (!team) throw new Error(`Linear team ${teamKey} not found`);
  const states = new Map(team.states.nodes.map((state) => [state.id, state.type]));
  const labels = new Map(
    data.issueLabels.nodes
      .filter((label) => !label.team || label.team.id === team.id)
      .map((label) => [label.name, label.id]),
  );
  const projects = new Map(data.projects.nodes.map((project) => [project.name, project.id]));
  const triage = team.states.nodes.find((state) => state.type === "triage");

  return {
    teamId: team.id,
    triageStateId() {
      if (!triage) throw new Error(`Turn on Triage for Linear team ${teamKey}`);
      return triage.id;
    },
    stateType: (stateId) => states.get(stateId),
    labelId(name) {
      const id = labels.get(name);
      if (!id) throw new Error(`Linear label "${name}" not found in team ${teamKey}`);
      return id;
    },
    hasLabel(labelIds, name) {
      const id = labels.get(name);
      return id !== undefined && labelIds.includes(id);
    },
    projectId(name) {
      const id = projects.get(name);
      if (!id) throw new Error(`Linear project "${name}" not found`);
      return id;
    },
  };
}

export function createLinearClient(options: LinearClientOptions): LinearClient {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: { context: LinearContext; at: number } | undefined;

  async function request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: options.apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const result = (await response.json()) as { data?: T; errors?: { message: string }[] };
    if (!response.ok || result.errors?.length || !result.data) {
      const message = result.errors?.map((error) => error.message).join("; ");
      throw new Error(`Linear request failed (${response.status}): ${message ?? "no data"}`);
    }
    return result.data;
  }

  /** Every node of a paginated connection, following its cursor. */
  async function allPages<T>(query: string, field: string): Promise<T[]> {
    const nodes: T[] = [];
    let after: string | null = null;
    do {
      const data: Record<string, Page<T>> = await request(query, { after });
      const page = data[field];
      nodes.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return nodes;
  }

  async function mutate<T extends { success: boolean }>(
    field: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const data = await request<Record<string, T>>(query, variables);
    const payload = data[field];
    if (!payload?.success) throw new Error(`Linear ${field} did not succeed`);
    return payload;
  }

  return {
    async context() {
      if (cached && now() - cached.at < CONTEXT_TTL_MS) return cached.context;
      const [{ teams }, labels, projects] = await Promise.all([
        request<Pick<ContextData, "teams">>(TEAM_QUERY, { teamKey: options.teamKey }),
        allPages<ContextData["issueLabels"]["nodes"][number]>(LABELS_QUERY, "issueLabels"),
        allPages<ContextData["projects"]["nodes"][number]>(PROJECTS_QUERY, "projects"),
      ]);
      const data: ContextData = { teams, issueLabels: { nodes: labels }, projects: { nodes: projects } };
      cached = { context: buildContext(options.teamKey, data), at: now() };
      return cached.context;
    },

    async createIssue(input) {
      const payload = await mutate<{ success: boolean; issue: CreatedIssue }>(
        "issueCreate",
        `mutation IntakeCreate($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier } }
        }`,
        { input },
      );
      return payload.issue;
    },

    async updateIssue(id, input) {
      await mutate(
        "issueUpdate",
        `mutation IntakeUpdate($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }`,
        { id, input },
      );
    },

    async comment(issueId, body) {
      await mutate(
        "commentCreate",
        `mutation IntakeComment($input: CommentCreateInput!) {
          commentCreate(input: $input) { success }
        }`,
        { input: { issueId, body } },
      );
    },

    async issue(id) {
      const data = await request<{
        issue: CreatedIssue & { title: string; description: string | null; state: { type: StateType } };
      }>(
        `query IntakeIssue($id: String!) {
          issue(id: $id) { id identifier title description state { type } }
        }`,
        { id },
      );
      const { state, description, ...issue } = data.issue;
      return { ...issue, description: description ?? "", stateType: state.type };
    },

    async attach(issueId, link) {
      await mutate(
        "attachmentCreate",
        `mutation IntakeAttach($input: AttachmentCreateInput!) {
          attachmentCreate(input: $input) { success }
        }`,
        { input: { issueId, ...link } },
      );
    },
  };
}
