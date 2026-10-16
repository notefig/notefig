import { describe, expect, it } from "vitest";
import { readReport, type ReportDeps } from "./reports";
import { createWorkflowStore } from "./store";
import { memoryStorage } from "./testing";
import { testSigner } from "./testing-jwt";

const NOW = Date.UTC(2026, 9, 16, 12);
const TEAM = "notefig.cloudflareaccess.com";
const AUD = "access-aud-tag";

async function setup() {
  const access = await testSigner();
  const store = createWorkflowStore(memoryStorage(), () => NOW);
  await store.admit({
    submissionId: "sub_1",
    fingerprint: "fp",
    limits: { submissionsPerDay: 5, perSubmitterPerDay: 5, blockAfterDeclines: 3, duplicatesPerDay: 5 },
  });
  const reportId = await store.saveReport("sub_1", "=== Notefig Debug Report ===");
  const deps = (configured = true): ReportDeps => ({
    access: configured ? { teamDomain: TEAM, audience: AUD, keys: access.keys } : undefined,
    store: (id) => (id === "feedback" ? store : undefined),
    now: () => NOW,
  });
  const token = (overrides: Record<string, unknown> = {}) =>
    access.sign({ iss: `https://${TEAM}`, aud: [AUD], exp: NOW / 1000 + 300, ...overrides });
  return { deps, token, reportId };
}

describe("readReport", () => {
  it("serves the report as private plain text to someone Access signed in", async () => {
    const { deps, token, reportId } = await setup();
    const response = await readReport(deps(), await token(), "feedback", reportId);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("=== Notefig Debug Report ===");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses a request without a valid Access token", async () => {
    const { deps, token, reportId } = await setup();
    expect((await readReport(deps(), null, "feedback", reportId)).status).toBe(403);
    const wrongApp = await token({ aud: ["another-app"] });
    expect((await readReport(deps(), wrongApp, "feedback", reportId)).status).toBe(403);
  });

  it("answers 404 while Access isn't configured, even with a token", async () => {
    const { deps, token, reportId } = await setup();
    expect((await readReport(deps(false), await token(), "feedback", reportId)).status).toBe(404);
  });

  it("answers 404 for an unknown workflow or report", async () => {
    const { deps, token } = await setup();
    const signedIn = await token();
    expect((await readReport(deps(), signedIn, "nope", "20261016-x")).status).toBe(404);
    expect(
      (await readReport(deps(), signedIn, "feedback", "20261016-00000000-0000-4000-8000-000000000000")).status,
    ).toBe(404);
  });
});
