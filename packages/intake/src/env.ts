import { createGitHubClient, type GitHubClient } from "./github";
import { createLinearClient, type LinearClient } from "./linear";
import type { BuildQueueObject } from "./build-queue-object";
import type { WorkflowState } from "./state-object";

/** The Worker's bindings, vars and secrets (wrangler.jsonc, README.md). */
export interface Env {
  WORKFLOW_STATE: DurableObjectNamespace<WorkflowState>;
  BUILD_QUEUE: DurableObjectNamespace<BuildQueueObject>;
  SUBMIT_LIMITER: RateLimit;
  LINEAR_API_KEY: string;
  LINEAR_WEBHOOK_SECRET: string;
  SUBMITTER_SALT: string;
  LINEAR_TEAM_KEY: string;
  /** Comma-separated Linear user ids whose actions count. */
  LINEAR_APPROVER_IDS: string;
  /** Comma-separated origins the app is served from. */
  ALLOWED_ORIGINS: string;
  /** owner/name of the repository agent builds run in. */
  GITHUB_REPOSITORY: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  /** Cloudflare Access for report links; reports are unreadable until both are set. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

let linearCache: { key: string; client: LinearClient } | undefined;
let githubCache: { key: string; client: GitHubClient } | undefined;

/** One client per isolate, so the Linear context cache outlives a request. */
export function linearFor(env: Env): LinearClient {
  const key = `${env.LINEAR_TEAM_KEY}:${env.LINEAR_API_KEY}`;
  if (linearCache?.key !== key) {
    linearCache = {
      key,
      client: createLinearClient({ apiKey: env.LINEAR_API_KEY, teamKey: env.LINEAR_TEAM_KEY }),
    };
  }
  return linearCache.client;
}

/** One client per isolate, so the installation token is reused until it expires. */
export function githubFor(env: Env): GitHubClient {
  const key = `${env.GITHUB_REPOSITORY}:${env.GITHUB_APP_ID}:${env.GITHUB_APP_PRIVATE_KEY}`;
  if (githubCache?.key !== key) {
    githubCache = {
      key,
      client: createGitHubClient({
        appId: env.GITHUB_APP_ID,
        privateKeyPem: env.GITHUB_APP_PRIVATE_KEY,
        repository: env.GITHUB_REPOSITORY,
      }),
    };
  }
  return githubCache.client;
}
