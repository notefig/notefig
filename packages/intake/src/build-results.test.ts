import { describe, expect, it } from "vitest";
import { GITHUB_OIDC_ISSUER, handleBuildResult } from "./build-results";
import type { BuildResult } from "./builds";
import { testSigner } from "./testing-jwt";

const NOW = Date.UTC(2026, 9, 16, 12);
const AUDIENCE = "https://intake.test";
const REPO = "notefig/notefig";
const BUILD_ID = "6f1c2a7e-3b7d-4c1e-9a55-0d6a3c1f2b10";

async function setup() {
  const github = await testSigner();
  const reported: BuildResult[] = [];
  const deliver = (authorization: string | null, body: unknown = { buildId: BUILD_ID, outcome: "failed" }) =>
    handleBuildResult(
      {
        keys: github.keys,
        audience: AUDIENCE,
        repository: REPO,
        report: async (result) => {
          reported.push(result);
          return true;
        },
        now: () => NOW,
      },
      authorization,
      body,
    );
  const token = (overrides: Record<string, unknown> = {}) =>
    github.sign({
      iss: GITHUB_OIDC_ISSUER,
      aud: AUDIENCE,
      exp: NOW / 1000 + 300,
      repository: REPO,
      workflow_ref: `${REPO}/.github/workflows/agent-build.yml@refs/heads/main`,
      event_name: "workflow_dispatch",
      ...overrides,
    });
  return { deliver, token, reported };
}

describe("handleBuildResult", () => {
  it("takes a result from agent-build.yml on main", async () => {
    const { deliver, token, reported } = await setup();
    const result = await deliver(`Bearer ${await token()}`);
    expect(result).toEqual({ status: 200, body: { known: true } });
    expect(reported).toEqual([{ buildId: BUILD_ID, outcome: "failed" }]);
  });

  it.each([
    ["another repository", { repository: "someone/fork" }],
    ["another workflow", { workflow_ref: `${REPO}/.github/workflows/ci-tests.yml@refs/heads/main` }],
    ["a branch other than main", { workflow_ref: `${REPO}/.github/workflows/agent-build.yml@refs/heads/evil` }],
    ["a run not started by dispatch", { event_name: "pull_request" }],
    ["another audience", { aud: "https://elsewhere.test" }],
  ])("refuses a token from %s", async (_, overrides) => {
    const { deliver, token, reported } = await setup();
    expect((await deliver(`Bearer ${await token(overrides)}`)).status).toBe(401);
    expect(reported).toEqual([]);
  });

  it("refuses a request with no token", async () => {
    const { deliver } = await setup();
    expect((await deliver(null)).status).toBe(401);
  });

  it("refuses a pull request link outside GitHub", async () => {
    const { deliver, token } = await setup();
    const body = { buildId: BUILD_ID, outcome: "opened", pullRequestUrl: "https://evil.test/pr" };
    expect((await deliver(`Bearer ${await token()}`, body)).status).toBe(400);
  });
});
