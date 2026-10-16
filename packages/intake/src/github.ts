import { importRsaPrivateKey, signJwt } from "./jwt";

/**
 * The one GitHub call the service makes: starting `agent-build.yml` with
 * `workflow_dispatch`, as the GitHub App. The App's installation token is
 * scoped to Actions: write on the one repository and cached until shortly
 * before it expires.
 */

const API = "https://api.github.com";
export const AGENT_BUILD_WORKFLOW = "agent-build.yml";

export interface BuildInputs {
  build_id: string;
  /** The Linear issue key, e.g. MET-123. Names the branch. */
  issue: string;
  title: string;
  body: string;
}

export interface GitHubClient {
  dispatchBuild(inputs: BuildInputs): Promise<void>;
}

export interface GitHubClientOptions {
  appId: string;
  privateKeyPem: string;
  /** owner/name */
  repository: string;
  fetch?: typeof fetch;
  now?: () => number;
}

const TOKEN_MARGIN_MS = 5 * 60_000;

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const [owner, repo] = options.repository.split("/");
  let privateKey: Promise<CryptoKey> | undefined;
  let token: { value: string; expiresAt: number } | undefined;

  async function call(path: string, auth: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${auth}`,
        "user-agent": "notefig-intake",
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed (${response.status})`);
    }
    return response;
  }

  async function appJwt(): Promise<string> {
    privateKey ??= importRsaPrivateKey(options.privateKeyPem);
    const seconds = Math.floor(now() / 1000);
    return signJwt({ iat: seconds - 60, exp: seconds + 9 * 60, iss: options.appId }, await privateKey);
  }

  async function installationToken(): Promise<string> {
    if (token && token.expiresAt - TOKEN_MARGIN_MS > now()) return token.value;
    const jwt = await appJwt();
    const installation = (await (await call(`/repos/${owner}/${repo}/installation`, jwt)).json()) as {
      id: number;
    };
    const issued = (await (
      await call(`/app/installations/${installation.id}/access_tokens`, jwt, {
        method: "POST",
        body: JSON.stringify({ repositories: [repo], permissions: { actions: "write" } }),
      })
    ).json()) as { token: string; expires_at: string };
    token = { value: issued.token, expiresAt: Date.parse(issued.expires_at) };
    return token.value;
  }

  return {
    async dispatchBuild(inputs) {
      await call(
        `/repos/${owner}/${repo}/actions/workflows/${AGENT_BUILD_WORKFLOW}/dispatches`,
        await installationToken(),
        { method: "POST", body: JSON.stringify({ ref: "main", inputs }) },
      );
    },
  };
}
