/** The Linear calls the support Worker makes: create an issue, comment on it. */

export interface IssueInput {
  teamId: string;
  stateId: string;
  projectId: string;
  labelIds: string[];
  title: string;
  description: string;
}

/** Files the issue and gives back its id. */
export type CreateIssue = (input: IssueInput) => Promise<string>;

/**
 * Adds a top-level comment. It starts its own thread, which Linear's
 * GitHub Issues sync never copies: only the issue's synced thread reaches
 * GitHub, so this is where anything private goes.
 */
export type CreateComment = (issueId: string, body: string) => Promise<void>;

const ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id } }
}`;

const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/** Linear's GraphQL API, with a personal API key. */
export function linearClient(
  apiKey: string,
  fetchFn: typeof fetch,
): { createIssue: CreateIssue; createComment: CreateComment } {
  async function query<T>(name: string, query: string, variables: object): Promise<T> {
    const response = await fetchFn("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const result = (await response.json().catch(() => ({}))) as GraphqlResponse<T>;
    if (!response.ok || result.errors?.length || !result.data) {
      const reason = result.errors?.map((error) => error.message).join("; ");
      throw new Error(`Linear ${name} failed (${response.status}): ${reason ?? "no detail"}`);
    }
    return result.data;
  }

  return {
    async createIssue(input) {
      const data = await query<{ issueCreate?: { success: boolean; issue?: { id: string } } }>(
        "issueCreate",
        ISSUE_CREATE,
        { input },
      );
      const id = data.issueCreate?.success ? data.issueCreate.issue?.id : undefined;
      if (!id) throw new Error("Linear issueCreate did not succeed");
      return id;
    },

    async createComment(issueId, body) {
      const data = await query<{ commentCreate?: { success: boolean } }>(
        "commentCreate",
        COMMENT_CREATE,
        { input: { issueId, body } },
      );
      if (!data.commentCreate?.success) throw new Error("Linear commentCreate did not succeed");
    },
  };
}
