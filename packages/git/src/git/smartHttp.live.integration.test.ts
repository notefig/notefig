/**
 * Opt-in live checks against the real hosts (the MET-266 spike's checks,
 * ported to our own client). Skipped unless a token is in the environment;
 * never commit one.
 *
 *   NOTEFIG_LIVE_GITHUB_TOKEN=… NOTEFIG_LIVE_GITLAB_TOKEN=… \
 *     npx jest smartHttp.live --runInBand
 *
 * Optional: NOTEFIG_LIVE_GITHUB_URL / NOTEFIG_LIVE_GITLAB_URL (each must
 * name a `notefig-sync-spike*` repo), NOTEFIG_LIVE_RESULTS (a JSON file to
 * append the latency numbers to).
 *
 * Rates stay low, enforced by the http port below: a poll or fetch at most
 * every 1 s and a push at most every 3 s per client, two clients. Any 429
 * fails the run (Throttled) and stops it.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import git from "isomorphic-git";

import { createIsomorphicGitFs } from "./isomorphicGitFs";
import { IsomorphicGitService } from "./isomorphicGitService";
import { NodeGitStorageHost } from "./realGit.test-helpers";
import {
  createBasicAuthProvider,
  createFetchHttpClient,
} from "./smartHttp/httpPorts";
import { ZERO_OID, type GitHttpClient, type GitRemote } from "./types";

const NS = "refs/notefig/v1";
const SPIKE = `${NS}/spike-269`;
const BRANCH_REF = "refs/heads/spike-sync";
const POLL_SAMPLES = 20;
const PUSH_SAMPLES = 10;

interface Host {
  name: string;
  url: string;
  username: string;
  otherUsername: string;
  token?: string;
}

const HOSTS: Host[] = [
  {
    name: "github",
    url:
      process.env.NOTEFIG_LIVE_GITHUB_URL ??
      "https://github.com/notefig/notefig-sync-spike.git",
    username: "x-access-token",
    otherUsername: "oauth2",
    token: process.env.NOTEFIG_LIVE_GITHUB_TOKEN,
  },
  {
    name: "gitlab",
    url:
      process.env.NOTEFIG_LIVE_GITLAB_URL ??
      "https://gitlab.com/parsasi/notefig-sync-spike.git",
    username: "oauth2",
    otherUsername: "x-access-token",
    token: process.env.NOTEFIG_LIVE_GITLAB_TOKEN,
  },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Node fetch (keep-alive), paced: a poll or fetch (each starts with the
 * upload-pack advertisement) at most every 1 s, a receive-pack POST at
 * most every 3 s, with a 20 s timeout.
 */
function pacedClient(): GitHttpClient {
  const inner = createFetchHttpClient((url, init) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(20_000) }),
  );
  const last = { poll: 0, push: 0 };
  const gap = { poll: 1000, push: 3000 };
  return {
    async request(request) {
      const paced = request.url.endsWith("info/refs?service=git-upload-pack")
        ? "poll"
        : request.method === "POST" && request.url.endsWith("receive-pack")
          ? "push"
          : null;
      if (!paced) return inner.request(request);
      const wait = last[paced] + gap[paced] - Date.now();
      if (wait > 0) await sleep(wait);
      last[paced] = Date.now();
      return inner.request(request);
    },
  };
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((x, y) => x - y);
  return Math.round(
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ],
  );
}

function stats(samples: number[]) {
  return {
    n: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    max: Math.round(Math.max(...samples)),
  };
}

async function timed<T>(
  op: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await op();
  return { value, ms: performance.now() - start };
}

interface Client {
  service: IsomorphicGitService;
  remote: GitRemote;
  blob(text: string): Promise<string>;
  commit(parent: string | null, text: string): Promise<string>;
  dispose(): void;
}

async function newClient(
  host: Host,
  username = host.username,
): Promise<Client> {
  const dir = mkdtempSync(join(tmpdir(), `nf-live-${host.name}-`));
  const repo = { repoPath: dir, gitDir: join(dir, ".git") };
  const storage = new NodeGitStorageHost(dir);
  const service = new IsomorphicGitService(storage, repo, {
    http: pacedClient(),
    auth: createBasicAuthProvider({
      live: { username, password: host.token! },
    }),
  });
  await service.init({ defaultBranch: "main" });
  const fs = createIsomorphicGitFs(storage);
  const ctx = { fs, dir, gitdir: repo.gitDir };
  const encode = (text: string) => new TextEncoder().encode(text);
  return {
    service,
    remote: { url: host.url, credential: "live" },
    blob: (text) => service.writeBlob(encode(text)),
    async commit(parent, text) {
      const blob = await git.writeBlob({
        ...ctx,
        blob: encode(`# Spike\n\n${text}\n`),
      });
      const tree = await git.writeTree({
        ...ctx,
        tree: [{ mode: "100644", path: "note.md", oid: blob, type: "blob" }],
      });
      const who = {
        name: "notefig sync spike",
        email: "spike@notefig.invalid",
        timestamp: Math.floor(Date.now() / 1000),
        timezoneOffset: 0,
      };
      return git.writeCommit({
        ...ctx,
        commit: {
          tree,
          parent: parent ? [parent] : [],
          author: who,
          committer: who,
          message: `${text}\n`,
        },
      });
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function remoteRefs(
  c: Client,
  prefixes: string[],
): Promise<Map<string, string>> {
  const refs = await c.service.listRemoteRefs(c.remote, prefixes);
  return new Map(refs.map((r) => [r.ref, r.oid]));
}

async function ensureBranch(c: Client): Promise<string> {
  let head = (await remoteRefs(c, [BRANCH_REF])).get(BRANCH_REF);
  if (!head) {
    const root = await c.commit(null, "spike branch root");
    const created = await c.service.pushRefs(c.remote, [
      { ref: BRANCH_REF, old: ZERO_OID, new: root },
    ]);
    expect(created.ok).toBe(true);
    head = root;
  } else {
    await c.service.fetchRefs(c.remote, [
      {
        ref: BRANCH_REF,
        oid: head,
        localRef: "refs/remotes/origin/spike-sync",
      },
    ]);
  }
  return head;
}

async function deleteSpikeRefs(c: Client): Promise<number> {
  const refs = await remoteRefs(c, [`${SPIKE}/`]);
  if (refs.size === 0) return 0;
  const result = await c.service.pushRefs(
    c.remote,
    [...refs].map(([ref, oid]) => ({ ref, old: oid, new: ZERO_OID })),
  );
  expect(result.ok).toBe(true);
  return refs.size;
}

for (const host of HOSTS) {
  const run = host.token ? describe : describe.skip;

  run(`live: ${host.name}`, () => {
    let a: Client;
    let b: Client;

    beforeAll(async () => {
      const path = new URL(host.url).pathname.replace(/\.git$/, "");
      if (!/\/notefig-sync-spike[\w.-]*$/.test(path)) {
        throw new Error(
          "live tests only run against a notefig-sync-spike* repo",
        );
      }
      a = await newClient(host);
      b = await newClient(host);
      await deleteSpikeRefs(a);
    }, 60_000);

    afterAll(async () => {
      if (a) await deleteSpikeRefs(a);
      a?.dispose();
      b?.dispose();
    }, 60_000);

    it("either Basic username works with the token", async () => {
      const other = await newClient(host, host.otherUsername);
      try {
        expect(
          (await remoteRefs(other, [BRANCH_REF])).size,
        ).toBeLessThanOrEqual(1);
      } finally {
        other.dispose();
      }
    }, 30_000);

    it("correctness: atomic multi-ref CAS, create-if-absent, CAS delete, blob refs, races", async () => {
      let head = await ensureBranch(a);
      const [r1, r2, r3] = ["one", "two", "three"].map(
        (n) => `${SPIKE}/lease/${n}`,
      );
      const x = await a.blob('{"t":"x"}');

      // atomic create-if-absent of three blob refs
      let p = await a.service.pushRefs(
        a.remote,
        [r1, r2, r3].map((ref) => ({ ref, old: ZERO_OID, new: x })),
        { atomic: true },
      );
      expect(p.ok).toBe(true);
      let ls = await remoteRefs(a, [`${SPIKE}/`]);
      expect([r1, r2, r3].map((r) => ls.get(r))).toEqual([x, x, x]);
      expect([...ls.keys()].every((r) => r.startsWith(SPIKE))).toBe(true);

      // create-if-absent refused while the ref exists
      const y = await a.blob('{"t":"y"}');
      p = await a.service.pushRefs(a.remote, [
        { ref: r1, old: ZERO_OID, new: y },
      ]);
      expect(p.refs[0].ok).toBe(false);

      // atomic with one stale old value moves nothing
      const c1 = await a.commit(head, "atomic stale test");
      p = await a.service.pushRefs(
        a.remote,
        [
          { ref: BRANCH_REF, old: head, new: c1 },
          { ref: r1, old: head, new: y },
        ],
        { atomic: true },
      );
      expect(p.ok).toBe(false);
      ls = await remoteRefs(a, [BRANCH_REF, r1]);
      expect([ls.get(BRANCH_REF), ls.get(r1)]).toEqual([head, x]);

      // non-atomic, one stale ref: refused. Whether the good ref lands is
      // per host — git http-backend and GitLab apply per ref, GitHub fails
      // the whole request ("failed") — so independent updates (presence)
      // must go in their own request, not just a non-atomic one.
      p = await a.service.pushRefs(a.remote, [
        { ref: BRANCH_REF, old: head, new: c1 },
        { ref: r1, old: head, new: y },
      ]);
      expect(p.refs[1].ok).toBe(false);
      const perRef = p.refs[0].ok;
      console.log(
        `${host.name}: a non-atomic push with one stale ref ${perRef ? "applies per ref" : "fails whole"}`,
      );
      expect((await remoteRefs(a, [BRANCH_REF])).get(BRANCH_REF)).toBe(
        perRef ? c1 : head,
      );
      if (!perRef) {
        p = await a.service.pushRefs(a.remote, [
          { ref: BRANCH_REF, old: head, new: c1 },
        ]);
        expect(p.ok).toBe(true);
      }
      head = c1;

      // CAS delete
      p = await a.service.pushRefs(a.remote, [
        { ref: r2, old: head, new: ZERO_OID },
      ]);
      expect(p.ok).toBe(false);
      p = await a.service.pushRefs(a.remote, [
        { ref: r2, old: x, new: ZERO_OID },
      ]);
      expect(p.ok).toBe(true);
      expect((await remoteRefs(a, [r2])).has(r2)).toBe(false);

      // blob ref fetched by the other client, byte for byte
      const fetched = await b.service.fetchRefs(b.remote, [{ ref: r3 }]);
      expect(fetched.refs[0].oid).toBe(x);
      expect(new TextDecoder().decode(await b.service.readBlob(x))).toBe(
        '{"t":"x"}',
      );

      // branch CAS race from the same head: exactly one winner
      await b.service.fetchRefs(b.remote, [{ ref: BRANCH_REF, oid: head }]);
      const ca = await a.commit(head, "race a");
      const cb = await b.commit(head, "race b");
      const [pa, pb] = await Promise.all([
        a.service.pushRefs(a.remote, [{ ref: BRANCH_REF, old: head, new: ca }]),
        b.service.pushRefs(b.remote, [{ ref: BRANCH_REF, old: head, new: cb }]),
      ]);
      expect([pa.ok, pb.ok].filter(Boolean)).toHaveLength(1);
      expect((await remoteRefs(a, [BRANCH_REF])).get(BRANCH_REF)).toBe(
        pa.ok ? ca : cb,
      );

      // create-if-absent race: exactly one winner
      const rr = `${SPIKE}/lease/race`;
      const [xa, xb] = [await a.blob('{"t":"ra"}'), await b.blob('{"t":"rb"}')];
      const [qa, qb] = await Promise.all([
        a.service.pushRefs(a.remote, [{ ref: rr, old: ZERO_OID, new: xa }]),
        b.service.pushRefs(b.remote, [{ ref: rr, old: ZERO_OID, new: xb }]),
      ]);
      expect([qa.ok, qb.ok].filter(Boolean)).toHaveLength(1);
    }, 180_000);

    it("latency: keep-alive poll, push and fetch", async () => {
      const poll: number[] = [];
      for (let i = 0; i < POLL_SAMPLES; i++) {
        await sleep(1000); // outside the timing, so the pacer never waits
        poll.push(
          (
            await timed(() =>
              a.service.listRemoteRefs(a.remote, [BRANCH_REF, `${NS}/`]),
            )
          ).ms,
        );
      }
      const ref = `${SPIKE}/presence/latency`;
      const push: number[] = [];
      const fetchMs: number[] = [];
      let old = ZERO_OID;
      for (let i = 0; i < PUSH_SAMPLES; i++) {
        await sleep(3000);
        const blob = await a.blob(JSON.stringify({ i, at: Date.now() }));
        const { value, ms } = await timed(() =>
          a.service.pushRefs(a.remote, [{ ref, old, new: blob }]),
        );
        expect(value.ok).toBe(true);
        push.push(ms);
        old = blob;
        await sleep(1000);
        fetchMs.push(
          (
            await timed(() =>
              b.service.fetchRefs(b.remote, [{ ref, oid: blob }]),
            )
          ).ms,
        );
      }
      const result = {
        host: host.name,
        at: new Date().toISOString(),
        pollColdMs: Math.round(poll[0]),
        pollWarm: stats(poll.slice(1)),
        pushWarm: stats(push.slice(1)),
        pushFirstMs: Math.round(push[0]),
        fetchBlobWarm: stats(fetchMs.slice(1)),
      };
      console.log(JSON.stringify(result));
      if (process.env.NOTEFIG_LIVE_RESULTS) {
        appendFileSync(
          process.env.NOTEFIG_LIVE_RESULTS,
          `${JSON.stringify(result)}\n`,
        );
      }
    }, 300_000);
  });
}
