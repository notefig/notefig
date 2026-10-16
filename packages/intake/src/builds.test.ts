import { describe, expect, it } from "vitest";
import { createBuildQueue } from "./build-queue";
import { BUILD_TIMEOUT_MS, createBuildService } from "./builds";
import type { BuildInputs } from "./github";
import type { IssueDetails } from "./linear";
import { memoryStorage } from "./testing";
import { fakeLinear } from "./testing-linear";

function setup(options: { issues?: Record<string, Partial<IssueDetails>>; failDispatch?: string[] } = {}) {
  let now = 0;
  let id = 0;
  const linear = fakeLinear({ issues: options.issues });
  const dispatched: BuildInputs[] = [];
  const builds = createBuildService({
    queue: createBuildQueue(memoryStorage(), { now: () => now, newId: () => `00000000-0000-4000-8000-00000000000${++id}` }),
    linear: linear.client,
    github: {
      async dispatchBuild(inputs) {
        if (options.failDispatch?.includes(inputs.issue)) throw new Error("GitHub said no");
        dispatched.push(inputs);
      },
    },
    now: () => now,
    warn: () => {},
  });
  const request = (issue: string) => builds.request({ issueId: issue, identifier: `MET-${issue}` });
  const comments = () =>
    linear.calls.flatMap((call) => (call.op === "comment" ? [`${call.issueId}: ${call.body}`] : []));
  const advance = (ms: number) => {
    now += ms;
  };
  return { builds, request, dispatched, comments, advance };
}

const BUILD_1 = "00000000-0000-4000-8000-000000000001";

describe("createBuildService", () => {
  it("dispatches the issue's title and description and says so on the issue", async () => {
    const { request, dispatched, comments } = setup();
    expect(await request("1")).toBe("started");
    expect(dispatched).toEqual([
      { build_id: BUILD_1, issue: "MET-1", title: "Title of 1", body: "Description of 1" },
    ]);
    expect(comments()).toEqual(["1: Agent build started. Its pull request will be linked here."]);
  });

  it("queues a second build, and dispatches it when the first reports back", async () => {
    const { builds, request, dispatched, comments } = setup();
    await request("1");
    expect(await request("2")).toBe("queued");
    expect(dispatched).toHaveLength(1);
    expect(comments()[1]).toBe("2: Agent build queued behind MET-1. It starts when they finish.");

    await builds.report({
      buildId: BUILD_1,
      outcome: "opened",
      pullRequestUrl: "https://github.com/notefig/notefig/pull/500",
    });
    expect(dispatched.map((inputs) => inputs.issue)).toEqual(["MET-1", "MET-2"]);
    expect(comments()).toContain("1: The agent build opened https://github.com/notefig/notefig/pull/500.");
  });

  it("quotes and defuses what the agent wrote when it skipped", async () => {
    const { builds, request, comments } = setup();
    await request("1");
    await builds.report({ buildId: BUILD_1, outcome: "skipped", detail: "SKIP: too big @everyone" });
    expect(comments().at(-1)).toContain("> SKIP: too big @​everyone");
  });

  it("skips an issue closed while it waited", async () => {
    const { builds, request, dispatched } = setup({ issues: { "2": { stateType: "canceled" } } });
    await request("1");
    await request("2");
    await request("3");
    await builds.report({ buildId: BUILD_1, outcome: "failed" });
    expect(dispatched.map((inputs) => inputs.issue)).toEqual(["MET-1", "MET-3"]);
  });

  it("moves on when GitHub refuses a dispatch", async () => {
    const { request, dispatched, comments } = setup({ failDispatch: ["MET-1"] });
    await request("1");
    expect(comments()[0]).toContain("couldn't be started");
    await request("2");
    expect(dispatched.map((inputs) => inputs.issue)).toEqual(["MET-2"]);
  });

  it("gives up on a build whose result never came back, and starts the next", async () => {
    const { builds, request, dispatched, comments, advance } = setup();
    await request("1");
    await request("2");
    expect(await builds.deadline()).toBe(BUILD_TIMEOUT_MS);
    advance(BUILD_TIMEOUT_MS - 1);
    await builds.expire();
    expect(dispatched).toHaveLength(1);
    advance(1);
    await builds.expire();
    expect(dispatched.map((inputs) => inputs.issue)).toEqual(["MET-1", "MET-2"]);
    expect(comments()).toContainEqual(expect.stringMatching(/^1: No result came back/));
  });

  it("ignores a result for a build it already gave up on", async () => {
    const { builds, request } = setup();
    await request("1");
    expect(await builds.report({ buildId: BUILD_1, outcome: "failed" })).toBe(true);
    expect(await builds.report({ buildId: BUILD_1, outcome: "failed" })).toBe(false);
  });
});
