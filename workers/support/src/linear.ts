/**
 * The Linear calls the support Worker makes: create an issue, comment on
 * it, read its comments, and upload and download its files.
 */

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

export interface IssueComment {
  author: string;
  body: string;
}

/** Every comment on the issue, oldest first: the private one holds the debug report and screenshots. */
export type IssueComments = (issueId: string) => Promise<IssueComment[]>;

export interface DownloadedFile {
  mediaType: string;
  bytes: Uint8Array;
}

/** A file uploaded to Linear (`uploads.linear.app`), read with the API key; null when it can't be. */
export type DownloadFile = (url: string) => Promise<DownloadedFile | null>;

export interface FileInput {
  bytes: Uint8Array;
  type: string;
  filename: string;
}

/** Stores a file in Linear and gives back its URL, visible only inside the workspace. */
export type UploadFile = (file: FileInput) => Promise<string>;

const ISSUE_CREATE = `mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id } }
}`;

const COMMENT_CREATE = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) { success }
}`;

const ISSUE_COMMENTS = `query IssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      nodes { body createdAt user { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const FILE_UPLOAD = `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
  fileUpload(contentType: $contentType, filename: $filename, size: $size) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}`;

interface GraphqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface UploadFileResult {
  uploadUrl: string;
  assetUrl: string;
  headers: { key: string; value: string }[];
}

/** Linear's GraphQL API, with a personal API key. */
export function linearClient(
  apiKey: string,
  fetchFn: typeof fetch,
): {
  createIssue: CreateIssue;
  createComment: CreateComment;
  uploadFile: UploadFile;
  issueComments: IssueComments;
  downloadFile: DownloadFile;
} {
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

    async issueComments(issueId) {
      type Node = { body: string; createdAt: string; user: { name: string } | null };
      type Page = { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      const nodes: Node[] = [];
      let after: string | null = null;
      do {
        const data: { issue?: { comments: Page } } = await query("issueComments", ISSUE_COMMENTS, {
          id: issueId,
          after,
        });
        const page = data.issue?.comments;
        nodes.push(...(page?.nodes ?? []));
        after = page?.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
      } while (after);
      return nodes
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((node) => ({ author: node.user?.name ?? "Linear", body: node.body }));
    },

    async downloadFile(url) {
      // The API key goes to Linear's file host only, whatever a comment links to.
      if (!isLinearUpload(url)) return null;
      const response = await fetchFn(url, { headers: { Authorization: apiKey } });
      if (!response.ok) return null;
      const mediaType = response.headers.get("Content-Type")?.split(";")[0] ?? "";
      return { mediaType, bytes: new Uint8Array(await response.arrayBuffer()) };
    },

    // Linear hands out a signed upload URL; the file goes there directly.
    async uploadFile({ bytes, type, filename }) {
      const data = await query<{ fileUpload?: { success: boolean; uploadFile?: UploadFileResult } }>(
        "fileUpload",
        FILE_UPLOAD,
        { contentType: type, filename, size: bytes.byteLength },
      );
      const upload = data.fileUpload?.uploadFile;
      if (!data.fileUpload?.success || !upload) throw new Error("Linear fileUpload did not succeed");
      const headers = new Headers({ "Content-Type": type, "Cache-Control": "public, max-age=31536000" });
      for (const { key, value } of upload.headers) headers.set(key, value);
      const put = await fetchFn(upload.uploadUrl, { method: "PUT", headers, body: bytes });
      if (!put.ok) throw new Error(`Linear file upload failed (${put.status})`);
      return upload.assetUrl;
    },
  };
}

/** An https URL on uploads.linear.app, where Linear keeps uploaded files. */
export function isLinearUpload(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "uploads.linear.app";
  } catch {
    return false;
  }
}
