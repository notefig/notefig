/** The one Linear call the support Worker makes: create an issue. */

export interface IssueInput {
  teamId: string;
  stateId: string;
  projectId: string;
  labelIds: string[];
  title: string;
  description: string;
}

export type CreateIssue = (input: IssueInput) => Promise<void>;

const ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success }
}`;

interface IssueCreateResponse {
  data?: { issueCreate?: { success: boolean } };
  errors?: { message: string }[];
}

/** `createIssue` over Linear's GraphQL API, with a personal API key. */
export function linearClient(apiKey: string, fetchFn: typeof fetch): CreateIssue {
  return async (input) => {
    const response = await fetchFn("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query: ISSUE_CREATE, variables: { input } }),
    });
    const result = (await response.json().catch(() => ({}))) as IssueCreateResponse;
    if (!response.ok || result.errors?.length || !result.data?.issueCreate?.success) {
      const reason = result.errors?.map((error) => error.message).join("; ");
      throw new Error(`Linear issueCreate failed (${response.status}): ${reason ?? "no detail"}`);
    }
  };
}
