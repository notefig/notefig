import type { KeyValueStorage } from "./store";

/**
 * Agent builds, one at a time: the order they run in and which one is
 * running. Builds share one Claude subscription, so a second build waits
 * for the first instead of competing with it for the rate limit. (A GitHub
 * Actions concurrency group can't do this: it keeps one pending run and
 * cancels the rest.)
 *
 * State lives in the `BuildQueue` Durable Object, one instance for the
 * service, so requests and results are handled one at a time. A build's
 * record is deleted when it finishes; a late result for it is ignored.
 * Keys are built only here, under `v1:` like the workflow store's.
 */

export interface BuildRequest {
  /** The Linear issue's id. */
  issueId: string;
  /** Its key, e.g. MET-123. */
  identifier: string;
}

export interface BuildRecord extends BuildRequest {
  id: string;
  status: "queued" | "running";
  requestedAt: number;
  startedAt?: number;
}

export type RequestResult =
  /** Nothing else is running: dispatch this build now. */
  | { kind: "start"; build: BuildRecord }
  /** Waits behind the running build and `ahead` queued ones. */
  | { kind: "queued"; build: BuildRecord; running: BuildRecord; ahead: number }
  /** The issue already has a build queued or running. */
  | { kind: "already"; build: BuildRecord };

export interface FinishResult {
  /** The build that finished, when it was known. */
  finished?: BuildRecord;
  /** The next build, now running: dispatch it. */
  next?: BuildRecord;
}

export interface BuildQueue {
  request(request: BuildRequest): Promise<RequestResult>;
  finish(buildId: string): Promise<FinishResult>;
  running(): Promise<BuildRecord | undefined>;
}

const key = {
  build: (id: string) => `v1:build:${id}`,
  issue: (issueId: string) => `v1:issue-build:${issueId}`,
  running: "v1:running-build",
  queuePrefix: "v1:queue:",
  queue: (requestedAt: number, id: string) => `v1:queue:${String(requestedAt).padStart(15, "0")}:${id}`,
};

export function createBuildQueue(
  storage: KeyValueStorage,
  { now = Date.now, newId = () => crypto.randomUUID() }: { now?: () => number; newId?: () => string } = {},
): BuildQueue {
  async function current(): Promise<BuildRecord | undefined> {
    const id = await storage.get<string>(key.running);
    return id ? storage.get<BuildRecord>(key.build(id)) : undefined;
  }

  async function startNext(): Promise<BuildRecord | undefined> {
    const queued = await storage.list<string>({ prefix: key.queuePrefix });
    const first = queued.entries().next();
    if (first.done) {
      await storage.delete(key.running);
      return undefined;
    }
    const [queueKey, id] = first.value;
    await storage.delete(queueKey);
    const record = await storage.get<BuildRecord>(key.build(id));
    if (!record) return startNext();
    const running: BuildRecord = { ...record, status: "running", startedAt: now() };
    await storage.put(key.build(id), running);
    await storage.put(key.running, id);
    return running;
  }

  return {
    async request({ issueId, identifier }) {
      const existingId = await storage.get<string>(key.issue(issueId));
      const existing = existingId ? await storage.get<BuildRecord>(key.build(existingId)) : undefined;
      if (existing) return { kind: "already", build: existing };

      const requestedAt = now();
      const build: BuildRecord = { id: newId(), issueId, identifier, status: "queued", requestedAt };
      await storage.put(key.build(build.id), build);
      await storage.put(key.issue(issueId), build.id);

      const running = await current();
      if (!running) {
        const started: BuildRecord = { ...build, status: "running", startedAt: requestedAt };
        await storage.put(key.build(build.id), started);
        await storage.put(key.running, build.id);
        return { kind: "start", build: started };
      }
      const ahead = (await storage.list({ prefix: key.queuePrefix })).size;
      await storage.put(key.queue(requestedAt, build.id), build.id);
      return { kind: "queued", build, running, ahead };
    },

    async finish(buildId) {
      const finished = await storage.get<BuildRecord>(key.build(buildId));
      if (!finished) return {};
      await storage.delete(key.build(buildId));
      await storage.delete(key.issue(finished.issueId));
      if (finished.status === "queued") {
        await storage.delete(key.queue(finished.requestedAt, buildId));
        return { finished };
      }
      return { finished, next: await startNext() };
    },

    running: current,
  };
}
