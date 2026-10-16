import { z } from "zod";
import type { BuildResult } from "./builds";
import { AGENT_BUILD_WORKFLOW } from "./github";
import { verifyJwt, type KeySet } from "./jwt";
import type { HttpResult } from "./submit";

/**
 * `POST /v1/builds/result`: agent-build.yml reporting how a build ended.
 * It authenticates with the GitHub Actions OIDC token, so no secret is
 * shared with the workflow: the token proves the request comes from
 * agent-build.yml on main in this repository, started by dispatch.
 */

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const GITHUB_OIDC_KEYS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;

const resultSchema = z.object({
  buildId: z.string().uuid(),
  outcome: z.enum(["opened", "skipped", "no-change", "failed"]),
  pullRequestUrl: z.string().url().startsWith("https://github.com/").optional(),
  runUrl: z.string().url().startsWith("https://github.com/").optional(),
  detail: z.string().max(20_000).optional(),
});

export interface BuildResultDeps {
  keys: KeySet;
  /** The audience agent-build.yml asks for: the service's origin. */
  audience: string;
  /** owner/name */
  repository: string;
  report(result: BuildResult): Promise<boolean>;
  now(): number;
}

export async function handleBuildResult(
  deps: BuildResultDeps,
  authorization: string | null,
  body: unknown,
): Promise<HttpResult> {
  const token = authorization?.match(/^Bearer (.+)$/)?.[1];
  const claims = token
    ? await verifyJwt(token, deps.keys, {
        issuer: GITHUB_OIDC_ISSUER,
        audience: deps.audience,
        now: deps.now,
      })
    : undefined;
  const workflowRef = `${deps.repository}/.github/workflows/${AGENT_BUILD_WORKFLOW}@refs/heads/main`;
  if (
    !claims ||
    claims.repository !== deps.repository ||
    claims.workflow_ref !== workflowRef ||
    claims.event_name !== "workflow_dispatch"
  ) {
    return { status: 401, body: { error: "Not agent-build.yml" } };
  }
  const result = resultSchema.safeParse(body);
  if (!result.success) return { status: 400, body: { error: "Bad result" } };
  const known = await deps.report(result.data);
  return { status: 200, body: { known } };
}
