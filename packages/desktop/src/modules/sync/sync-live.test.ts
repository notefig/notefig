// @vitest-environment node
/**
 * Opt-in: the sync worker's code path against a real host. Two clones of
 * the live test repo sync on a throwaway branch: one pushes a commit, the
 * other polls, pulls it and pushes its own. Skipped unless
 * `NOTEFIG_SYNC_LIVE_URL` and `NOTEFIG_SYNC_LIVE_TOKEN` are set (with
 * `NOTEFIG_SYNC_LIVE_USER`, default `x-access-token`). Never commit a token.
 *
 * The worker API is the real one (`createInProcessSyncWorker`); the http
 * port is Node's fetch with Basic auth added here, standing in for Rust.
 * Low rate: a handful of requests, at least 1 s apart.
 */
import { mkdtempSync, promises as fsp, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IsomorphicGitService,
  ZERO_OID,
  createBasicAuthProvider,
  createFetchHttpClient,
  type GitHttpClient,
} from "@notefig/git";
import { createGitStorageHost } from "@/adapters/git-storage-host";
import { nodeFs, runGit } from "@/testing/test-sync";
import { createInProcessSyncWorker } from "./engine/sync-worker-api";
import { remoteCredentialKey, sessionSpecOf } from "./sync-config";
import type { SyncResult, SyncWorkerApi } from "./sync-types";

const URL_ = process.env.NOTEFIG_SYNC_LIVE_URL ?? "";
const TOKEN = process.env.NOTEFIG_SYNC_LIVE_TOKEN ?? "";
const USER = process.env.NOTEFIG_SYNC_LIVE_USER ?? "x-access-token";
const FILE = "notefig-sync-270.md";
const fs = nodeFs();
const pause = () => new Promise((resolve) => setTimeout(resolve, 1_100));
const latencies: Record<string, number[]> = {};

/** Node's fetch plus Basic auth: what Rust does on desktop. */
function liveHttp(): GitHttpClient {
  const auth = createBasicAuthProvider({
    [remoteCredentialKey(URL_)]: { username: USER, password: TOKEN },
  });
  const client = createFetchHttpClient(fetch as never);
  return { request: async (request) => client.request(await auth.authorize(request)) };
}

async function timed<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  (latencies[name] ??= []).push(Math.round(performance.now() - started));
  return result;
}

function value<T>(result: SyncResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** A system-git clone on the throwaway branch. */
async function cloneLive(root: string, name: string, branch: string) {
  const header = `Authorization: Basic ${Buffer.from(`${USER}:${TOKEN}`).toString("base64")}`;
  const path = join(root, name);
  await runGit(root, ["-c", `http.extraHeader=${header}`, "clone", "-q", URL_, path]);
  await runGit(path, ["checkout", "-q", "-b", branch]);
  const worker = createInProcessSyncWorker(() => createGitStorageHost(fs), liveHttp(), fs);
  value(await worker.open(sessionSpecOf(path, { remote: URL_, branch })));
  return { path, worker };
}

async function commitFile(
  device: { path: string; worker: SyncWorkerApi },
  text: string,
  name: string,
) {
  await fsp.writeFile(join(device.path, FILE), text);
  const author = { name, email: `${name}@live.test` };
  return value(await device.worker.commit({ paths: [FILE], author, userName: name }));
}

/** Remove the throwaway branch with a compare-and-swap delete. */
async function deleteBranch(repoPath: string, branch: string) {
  const remote = { url: URL_, credential: remoteCredentialKey(URL_) };
  const service = new IsomorphicGitService(
    createGitStorageHost(fs),
    { repoPath, gitDir: join(repoPath, ".git") },
    { http: liveHttp() },
  );
  const refs = await service.listRemoteRefs(remote, [`refs/heads/${branch}`]).catch(() => []);
  const tip = refs.find((ref) => ref.ref === `refs/heads/${branch}`);
  if (tip) await service.pushRefs(remote, [{ ref: tip.ref, old: tip.oid, new: ZERO_OID }]);
}

describe.skipIf(!URL_ || !TOKEN)("sync worker against a live host", () => {
  it("pushes, polls, pulls and pushes again on a throwaway branch", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "notefig-sync-live-"));
    const branch = `notefig-sync-270-${Date.now()}`;
    try {
      const a = await cloneLive(root, "a", branch);
      const b = await cloneLive(root, "b", branch);

      // A creates the branch with a commit.
      expect((await commitFile(a, "From A.\n", "live-a")).oid).toBeTruthy();
      const created = value(await timed("push", () => a.worker.push({ remote: null })));
      expect(created.status).toBe("pushed");
      await pause();

      // B polls and fast-forwards onto it; the write comes back for the
      // main thread to apply.
      const { remote } = value(await timed("poll", () => b.worker.poll()));
      expect(created.status === "pushed" && remote === created.head).toBe(true);
      const pulled = value(await timed("pull", () => b.worker.pull({ remote: remote! })));
      expect(pulled).toMatchObject({
        status: "fast-forward",
        writes: [{ path: FILE, kind: "text", text: "From A.\n" }],
      });
      await fsp.writeFile(join(b.path, FILE), "From A.\n");
      await pause();

      // B pushes its own edit; A sees it on its next poll.
      await commitFile(b, "From A.\nAnd B.\n", "live-b");
      const pushed = value(await timed("push", () => b.worker.push({ remote })));
      expect(pushed.status).toBe("pushed");
      await pause();
      const seen = value(await timed("poll", () => a.worker.poll()));
      expect(pushed.status === "pushed" && seen.remote === pushed.head).toBe(true);
      console.log("[sync-live] latencies (ms):", JSON.stringify(latencies));
    } finally {
      await deleteBranch(join(root, "a"), branch);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("merges two devices' overlapping edits through a refused push", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "notefig-sync-live-"));
    const branch = `notefig-sync-271-${Date.now()}`;
    const base = "# Live\n\nFirst paragraph.\n\nSecond paragraph here.\n\nThird paragraph.\n";
    try {
      const a = await cloneLive(root, "a", branch);
      const b = await cloneLive(root, "b", branch);
      await commitFile(a, base, "live-a");
      const created = value(await a.worker.push({ remote: null }));
      expect(created.status).toBe("pushed");
      const tip = created.status === "pushed" ? created.head : "";
      await pause();
      value(await b.worker.pull({ remote: tip }));
      await fsp.writeFile(join(b.path, FILE), base);
      await pause();

      // Both edit: different blocks, and the same word of one sentence.
      await commitFile(a, base.replace("First paragraph.", "First paragraph, by A.").replace("here", "now"), "live-a");
      await commitFile(b, base.replace("Third paragraph.", "Third paragraph, by B.").replace("here", "today"), "live-b");
      expect(value(await timed("push", () => a.worker.push({ remote: tip }))).status).toBe("pushed");
      await pause();
      // B's compare-and-swap is stale: refused.
      expect(value(await b.worker.push({ remote: tip })).status).toBe("rejected");
      await pause();
      const { remote } = value(await timed("poll", () => b.worker.poll()));
      const merged = value(
        await timed("pull+merge", () => b.worker.pull({ remote: remote!, merge: true })),
      );
      expect(merged).toMatchObject({ status: "rebased" });
      if (merged.status !== "rebased") return;
      expect(merged.overwritten).toEqual([{ path: FILE, fragments: ["today"] }]);
      expect(merged.recoveryRef).toMatch(/^refs\/notefig-local\/recovery\//);
      const text = merged.writes.find((write) => write.path === FILE);
      expect(text).toMatchObject({
        kind: "text",
        text: "# Live\n\nFirst paragraph, by A.\n\nSecond paragraph now.\n\nThird paragraph, by B.\n",
      });
      await pause();
      expect(value(await timed("push", () => b.worker.push({ remote })))).toMatchObject({ status: "pushed" });
      console.log("[sync-live] merge latencies (ms):", JSON.stringify(latencies));
    } finally {
      await deleteBranch(join(root, "a"), branch);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
