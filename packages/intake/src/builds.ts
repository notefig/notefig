import type { BuildQueue, BuildRecord, BuildRequest } from "./build-queue";
import type { GitHubClient } from "./github";
import type { LinearClient } from "./linear";
import { quoteUserText } from "./workflow";

/**
 * Runs agent builds off the queue: dispatches `agent-build.yml` for the
 * build that may start, takes the result the workflow posts back, and
 * keeps the Linear issue told at each step. A build whose result never
 * comes back (a lost runner) is given up on after `BUILD_TIMEOUT_MS`, so
 * the queue can't stall.
 */

/** Adding this label to an issue in Linear starts a build (linear-webhook.ts). */
export const AGENT_BUILD_LABEL = "agent:build";

/** Longer than agent-build.yml's 45-minute job timeout, plus queueing on GitHub. */
export const BUILD_TIMEOUT_MS = 75 * 60_000;
const MAX_BODY_CHARS = 50_000;
const MAX_DETAIL_CHARS = 4_000;

export type BuildOutcome = "opened" | "skipped" | "no-change" | "failed";

export interface BuildResult {
  buildId: string;
  outcome: BuildOutcome;
  pullRequestUrl?: string;
  runUrl?: string;
  /** What the agent wrote when it skipped the issue. */
  detail?: string;
}

export interface BuildService {
  /** Queues a build for an issue, or starts it when nothing is running. */
  request(request: BuildRequest): Promise<"started" | "queued" | "already">;
  /** A result from agent-build.yml. False when the build wasn't known. */
  report(result: BuildResult): Promise<boolean>;
  /** Gives up on a running build past its timeout. */
  expire(): Promise<void>;
  /** When the running build times out, if one is running. */
  deadline(): Promise<number | undefined>;
}

/** What the Worker calls on the build queue's Durable Object. */
export interface BuildQueueRpc {
  request(request: BuildRequest): Promise<"started" | "queued" | "already">;
  report(result: BuildResult): Promise<boolean>;
}

export interface BuildServiceDeps {
  queue: BuildQueue;
  linear: LinearClient;
  github: GitHubClient;
  now?: () => number;
  warn(message: string, error: unknown): void;
}

const OPEN_STATES = new Set(["triage", "backlog", "unstarted", "started"]);

export function createBuildService(deps: BuildServiceDeps): BuildService {
  const now = deps.now ?? Date.now;

  async function comment(issueId: string, body: string): Promise<void> {
    await deps.linear.comment(issueId, body).catch((error: unknown) => {
      deps.warn("build comment failed", error);
    });
  }

  /** Dispatches `build`, then the builds after it while dispatches fail. */
  async function dispatch(build: BuildRecord | undefined): Promise<void> {
    for (let next = build; next; next = await dispatchOne(next));
  }

  /** Dispatches one build; when it can't run, finishes it and returns the next. */
  async function dispatchOne(build: BuildRecord): Promise<BuildRecord | undefined> {
    try {
      const issue = await deps.linear.issue(build.issueId);
      if (!OPEN_STATES.has(issue.stateType)) return (await deps.queue.finish(build.id)).next;
      await deps.github.dispatchBuild({
        build_id: build.id,
        issue: issue.identifier,
        title: issue.title,
        body: issue.description.slice(0, MAX_BODY_CHARS),
      });
      await comment(build.issueId, "Agent build started. Its pull request will be linked here.");
      return undefined;
    } catch (error) {
      deps.warn("build dispatch failed", error);
      await comment(
        build.issueId,
        "The agent build couldn't be started. Remove `agent:build` and add it again to retry.",
      );
      return (await deps.queue.finish(build.id)).next;
    }
  }

  return {
    async request(request) {
      const result = await deps.queue.request(request);
      if (result.kind === "already") return "already";
      if (result.kind === "queued") {
        const ahead = result.ahead ? ` and ${result.ahead} more` : "";
        await comment(
          request.issueId,
          `Agent build queued behind ${result.running.identifier}${ahead}. It starts when they finish.`,
        );
        return "queued";
      }
      await dispatch(result.build);
      return "started";
    },

    async report(result) {
      const { finished, next } = await deps.queue.finish(result.buildId);
      if (!finished) return false;
      await comment(finished.issueId, resultComment(result));
      await dispatch(next);
      return true;
    },

    async expire() {
      const running = await deps.queue.running();
      if (running?.startedAt === undefined || now() - running.startedAt < BUILD_TIMEOUT_MS) return;
      const { next } = await deps.queue.finish(running.id);
      await comment(
        running.issueId,
        "No result came back from the agent build in time, so it was given up on. " +
          "Remove `agent:build` and add it again to retry.",
      );
      await dispatch(next);
    },

    async deadline() {
      const running = await deps.queue.running();
      return running?.startedAt === undefined ? undefined : running.startedAt + BUILD_TIMEOUT_MS;
    },
  };
}

function resultComment({ outcome, pullRequestUrl, runUrl, detail }: BuildResult): string {
  const run = runUrl ? ` ([run](${runUrl}))` : "";
  switch (outcome) {
    case "opened":
      return `The agent build opened ${pullRequestUrl ?? "a pull request"}${run}.`;
    case "no-change":
      return `The agent build made no changes${run}.`;
    case "skipped":
      return [
        `The agent build didn't open a pull request${run}. It said:`,
        "",
        quoteUserText((detail ?? "").slice(0, MAX_DETAIL_CHARS)),
      ].join("\n");
    case "failed":
      return `The agent build failed${run}.`;
  }
}
