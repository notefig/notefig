/**
 * The remote operations against real `git http-backend` (MET-269): ls-refs,
 * targeted fetch, multi-ref CAS pushes (atomic and not), create-if-absent,
 * CAS delete, blob refs, a two-client race, rebaseOnto with the default and
 * an injected merge driver, and HTTP status → GitError mapping.
 */
import { join } from "node:path";
import { readFileSync } from "node:fs";

import {
  bareRef,
  cloneFixture,
  createRemoteFixture,
  nodeHttpClient,
  startFakeServer,
  type LocalClone,
  type RemoteFixture,
  type TestServer,
  writeFileText,
} from "./smartHttp.test-helpers";
import {
  SYSTEM_GIT_IDENTITY,
  hasSystemGit,
  runGit,
  runGitAllowFail,
} from "./realGit.test-helpers";
import { createBasicAuthProvider } from "./smartHttp/httpPorts";
import { IsomorphicGitService } from "./isomorphicGitService";
import { NodeGitStorageHost } from "./realGit.test-helpers";
import {
  GitError,
  ZERO_OID,
  type GitMergeDriver,
  type GitRemote,
} from "./types";

const describeGit = hasSystemGit ? describe : describe.skip;
const MAIN = "refs/heads/main";
const LEASE = "refs/notefig/v1/locks/doc/holder";
const encode = (text: string) => new TextEncoder().encode(text);

function packObjectCount(body: Buffer): number | null {
  const at = body.indexOf("PACK");
  return at < 0 ? null : body.readUInt32BE(at + 8);
}

describeGit("smart HTTP remote operations (git http-backend)", () => {
  let fixture: RemoteFixture;
  let remote: GitRemote;
  let a: LocalClone;
  let b: LocalClone;

  beforeEach(async () => {
    fixture = await createRemoteFixture();
    remote = { url: fixture.url };
    a = await cloneFixture(fixture, "a");
    b = await cloneFixture(fixture, "b");
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  const head = () => bareRef(fixture, MAIN) as Promise<string>;

  it("lists only the refs under the requested prefixes", async () => {
    const main = await head();
    await runGit(fixture.bare, [
      "update-ref",
      "refs/notefig/v1/presence/dev1",
      main,
    ]);
    await runGit(fixture.bare, ["update-ref", "refs/heads/other", main]);

    const notefig = await a.service.listRemoteRefs(remote, [
      "refs/notefig/v1/",
    ]);
    expect(notefig).toEqual([
      { ref: "refs/notefig/v1/presence/dev1", oid: main },
    ]);

    const both = await a.service.listRemoteRefs(remote, [
      MAIN,
      "refs/notefig/",
    ]);
    expect(both.map((r) => r.ref).sort()).toEqual([
      MAIN,
      "refs/notefig/v1/presence/dev1",
    ]);
  });

  it("fetches exactly the named ref, in one request when the oid is known", async () => {
    const feature = await b.commitFiles({ "feature.md": "f\n" }, "feature");
    const other = await b.commitFiles({ "other.md": "o\n" }, "other");
    await runGit(b.repo.repoPath, [
      "push",
      "-q",
      "origin",
      `${feature}:refs/heads/feature`,
    ]);
    await runGit(b.repo.repoPath, [
      "push",
      "-q",
      "origin",
      `${other}:refs/heads/other`,
    ]);

    const before = fixture.server.requests.length;
    const result = await a.service.fetchRefs(remote, [
      {
        ref: "refs/heads/feature",
        oid: feature,
        localRef: "refs/remotes/origin/feature",
      },
    ]);
    expect(fixture.server.requests.length - before).toBe(1);
    expect(result).toEqual({
      refs: [
        {
          ref: "refs/heads/feature",
          oid: feature,
          localRef: "refs/remotes/origin/feature",
        },
      ],
      missing: [],
      objectCount: 3,
    });
    expect(await a.service.readRef("refs/remotes/origin/feature")).toBe(
      feature,
    );
    expect(
      (await runGitAllowFail(a.repo.repoPath, ["cat-file", "-e", other])).code,
    ).not.toBe(0);
    expect(
      await runGit(a.repo.repoPath, ["fsck", "--connectivity-only", feature]),
    ).toBe("");

    // Already local: no request at all. Unknown oid: one ls-refs first.
    const again = fixture.server.requests.length;
    await a.service.fetchRefs(remote, [
      { ref: "refs/heads/feature", oid: feature },
    ]);
    expect(fixture.server.requests.length).toBe(again);
    const looked = await a.service.fetchRefs(remote, [
      { ref: "refs/heads/other" },
      { ref: "refs/heads/nope" },
    ]);
    expect(looked.refs).toEqual([
      { ref: "refs/heads/other", oid: other, localRef: undefined },
    ]);
    expect(looked.missing).toEqual(["refs/heads/nope"]);
  });

  it("atomic: one stale old value rejects the whole push", async () => {
    const main = await head();
    const lease = await a.service.writeBlob(encode('{"blocks":[]}'));
    await runGit(fixture.bare, ["update-ref", LEASE, main]);
    const next = await a.commitFiles({ "note.md": "changed\n" }, "edit");

    const result = await a.service.pushRefs(
      remote,
      [
        { ref: MAIN, old: main, new: next },
        { ref: LEASE, old: ZERO_OID /* stale: it exists */, new: lease },
      ],
      { atomic: true },
    );
    expect(result.ok).toBe(false);
    expect(result.unpack).toBe("ok");
    expect(result.refs.map((r) => r.ok)).toEqual([false, false]);
    expect(await head()).toBe(main);
    expect(await bareRef(fixture, LEASE)).toBe(main);
  });

  it("non-atomic: the same push applies per ref", async () => {
    const main = await head();
    const lease = await a.service.writeBlob(encode('{"blocks":[]}'));
    await runGit(fixture.bare, ["update-ref", LEASE, main]);
    const next = await a.commitFiles({ "note.md": "changed\n" }, "edit");

    const result = await a.service.pushRefs(remote, [
      { ref: MAIN, old: main, new: next },
      { ref: LEASE, old: ZERO_OID, new: lease },
    ]);
    expect(result.ok).toBe(false);
    expect(result.refs[0]).toEqual({ ref: MAIN, ok: true });
    expect(result.refs[1]).toMatchObject({ ref: LEASE, ok: false });
    expect(await head()).toBe(next);
    expect(await bareRef(fixture, LEASE)).toBe(main);
  });

  it("sends only the changed objects (commit, root tree, one blob)", async () => {
    await a.commitFiles({ "docs/a.md": "a\n", "docs/b.md": "b\n" }, "two docs");
    const base = await a.service.readRef(MAIN);
    await runGit(a.repo.repoPath, ["push", "-q", "origin", "main"]);
    const next = await a.commitFiles({ "docs/a.md": "a2\n" }, "edit a");

    const before = fixture.server.requests.length;
    const result = await a.service.pushRefs(remote, [
      { ref: MAIN, old: base!, new: next },
    ]);
    expect(result.ok).toBe(true);
    const post = fixture.server.requests
      .slice(before)
      .find((r) => r.method === "POST")!;
    // commit + root tree + docs/ tree + docs/a.md blob
    expect(packObjectCount(post.body)).toBe(4);
    expect(await runGit(fixture.bare, ["fsck", "--connectivity-only"])).toBe(
      "",
    );
  });

  it("a shallow clone can create a remote branch without naming a have", async () => {
    await b.commitFiles({ "note.md": "second\n" }, "second");
    await runGit(b.repo.repoPath, ["push", "-q", "origin", "main"]);
    const repoPath = join(fixture.root, "shallow");
    await runGit(fixture.root, [
      "clone",
      "-q",
      "--depth",
      "1",
      `file://${fixture.bare}`,
      repoPath,
    ]);
    const service = new IsomorphicGitService(
      new NodeGitStorageHost(repoPath),
      { repoPath, gitDir: join(repoPath, ".git") },
      { http: nodeHttpClient() },
    );
    await writeFileText(join(repoPath, "new.md"), "new\n");
    await runGit(repoPath, ["add", "new.md"]);
    await runGit(repoPath, [
      ...SYSTEM_GIT_IDENTITY,
      "commit",
      "-q",
      "-m",
      "on a shallow clone",
    ]);
    const tip = await runGit(repoPath, ["rev-parse", "HEAD"]);

    const result = await service.pushRefs(remote, [
      { ref: "refs/heads/feature", old: ZERO_OID, new: tip },
    ]);
    expect(result.ok).toBe(true);
    expect(await bareRef(fixture, "refs/heads/feature")).toBe(tip);
    expect(await runGit(fixture.bare, ["fsck", "--connectivity-only"])).toBe(
      "",
    );
  });

  it("create-if-absent succeeds once, then fails while the ref exists", async () => {
    const one = await a.service.writeBlob(encode("one"));
    const two = await a.service.writeBlob(encode("two"));
    const first = await a.service.pushRefs(remote, [
      { ref: LEASE, old: ZERO_OID, new: one },
    ]);
    expect(first.ok).toBe(true);
    const second = await a.service.pushRefs(remote, [
      { ref: LEASE, old: ZERO_OID, new: two },
    ]);
    expect(second.ok).toBe(false);
    expect(second.refs[0].ok).toBe(false);
    expect(await bareRef(fixture, LEASE)).toBe(one);
  });

  it("CAS delete: a wrong old value is refused, the right one deletes, and no pack is sent", async () => {
    const one = await a.service.writeBlob(encode("one"));
    await a.service.pushRefs(remote, [{ ref: LEASE, old: ZERO_OID, new: one }]);
    const main = await head();

    const wrong = await a.service.pushRefs(remote, [
      { ref: LEASE, old: main, new: ZERO_OID },
    ]);
    expect(wrong.ok).toBe(false);
    expect(await bareRef(fixture, LEASE)).toBe(one);

    const before = fixture.server.requests.length;
    const right = await a.service.pushRefs(remote, [
      { ref: LEASE, old: one, new: ZERO_OID },
    ]);
    expect(right).toMatchObject({ ok: true, refs: [{ ref: LEASE, ok: true }] });
    expect(await bareRef(fixture, LEASE)).toBeNull();
    const post = fixture.server.requests
      .slice(before)
      .find((r) => r.method === "POST")!;
    expect(packObjectCount(post.body)).toBeNull();
  });

  it("refs may point straight at blobs, and fetch back byte for byte", async () => {
    const payload = encode(
      JSON.stringify({ user: "a", cursor: { block: 2, offset: 5 } }),
    );
    const blob = await a.service.writeBlob(payload);
    const ref = "refs/notefig/v1/presence/dev-a";
    expect(
      (await a.service.pushRefs(remote, [{ ref, old: ZERO_OID, new: blob }]))
        .ok,
    ).toBe(true);
    expect(
      await a.service.listRemoteRefs(remote, ["refs/notefig/v1/presence/"]),
    ).toEqual([{ ref, oid: blob }]);
    expect(await runGit(fixture.bare, ["cat-file", "-t", blob])).toBe("blob");

    const fetched = await b.service.fetchRefs(remote, [
      { ref, localRef: "refs/notefig-remote/presence/dev-a" },
    ]);
    expect(fetched.objectCount).toBe(1);
    expect(await b.service.readBlob(blob)).toEqual(payload);
    expect(await b.service.readRef("refs/notefig-remote/presence/dev-a")).toBe(
      blob,
    );
  });

  it("two concurrent pushes from the same base: exactly one wins", async () => {
    const base = await head();
    const ca = await a.commitFiles({ "note.md": "from a\n" }, "a");
    const cb = await b.commitFiles({ "note.md": "from b\n" }, "b");
    const [ra, rb] = await Promise.all([
      a.service.pushRefs(remote, [{ ref: MAIN, old: base, new: ca }]),
      b.service.pushRefs(remote, [{ ref: MAIN, old: base, new: cb }]),
    ]);
    expect([ra.ok, rb.ok].filter(Boolean)).toHaveLength(1);
    expect(await head()).toBe(ra.ok ? ca : cb);
  });

  it("writeRef / readRef / deleteRef work locally on any object", async () => {
    const blob = await a.service.writeBlob(encode("x"));
    await a.service.writeRef({
      ref: "refs/notefig-local/recovery/1",
      oid: blob,
    });
    expect(await a.service.readRef("refs/notefig-local/recovery/1")).toBe(blob);
    await a.service.deleteRef("refs/notefig-local/recovery/1");
    expect(await a.service.readRef("refs/notefig-local/recovery/1")).toBeNull();
    await expect(
      a.service.deleteRef("refs/notefig-local/recovery/1"),
    ).resolves.toBeUndefined();
  });

  describe("rebaseOnto", () => {
    async function diverge(
      ours: Record<string, string>,
      theirs: Record<string, string>,
    ) {
      const base = await head();
      const upstream = await b.commitFiles(theirs, "theirs");
      await runGit(b.repo.repoPath, ["push", "-q", "origin", "main"]);
      const local = await a.commitFiles(ours, "ours");
      await a.service.fetchRefs(remote, [
        { ref: MAIN, localRef: "refs/remotes/origin/main" },
      ]);
      return { base, upstream, local };
    }
    const note = (clone: LocalClone) =>
      readFileSync(join(clone.repo.repoPath, "note.md"), "utf8");

    it("default driver: overlapping edits conflict with markers and nothing moves", async () => {
      const { base, upstream, local } = await diverge(
        { "note.md": "line one\nOURS two\nline three\n" },
        { "note.md": "line one\nTHEIRS two\nline three\n" },
      );
      expect(await a.service.mergeBase(MAIN, "refs/remotes/origin/main")).toBe(
        base,
      );

      const result = await a.service.rebaseOnto({ theirs: upstream });
      expect(result.status).toBe("conflicted");
      if (result.status !== "conflicted") return;
      expect(result.conflicts).toEqual([
        {
          commit: local,
          path: "note.md",
          reason: "content",
          content:
            "line one\n<<<<<<< ours\nOURS two\n=======\nTHEIRS two\n>>>>>>> theirs\nline three\n",
        },
      ]);
      expect(await a.service.readRef(MAIN)).toBe(local);
      expect(note(a)).toBe("line one\nOURS two\nline three\n");
    });

    it("default driver: separate lines merge cleanly and the push fast-forwards", async () => {
      const { upstream } = await diverge(
        { "note.md": "line ONE\nline two\nline three\n" },
        { "note.md": "line one\nline two\nline THREE\n" },
      );
      const result = await a.service.rebaseOnto({ theirs: upstream });
      expect(result).toMatchObject({
        status: "rebased",
        replayed: 1,
        skippedDirty: [],
      });
      expect(note(a)).toBe("line ONE\nline two\nline THREE\n");
      expect((await a.service.status()).unstaged).toEqual([]);
      const tip = await a.service.readRef(MAIN);
      const push = await a.service.pushRefs(remote, [
        { ref: MAIN, old: upstream, new: tip! },
      ]);
      expect(push.ok).toBe(true);
    });

    it("injected driver: called only for files both sides changed; its result wins", async () => {
      const calls: string[] = [];
      const driver: GitMergeDriver = {
        merge({ path, ours, theirs, holder }) {
          calls.push(`${path}:${holder}`);
          return { content: `${theirs}${ours}`, overwritten: ["lost"] };
        },
      };
      const service = new IsomorphicGitService(
        new NodeGitStorageHost(a.repo.repoPath),
        a.repo,
        {
          http: nodeHttpClient(),
          mergeDriver: driver,
        },
      );
      const { upstream, local } = await diverge(
        { "note.md": "OURS\n", "mine.md": "mine\n" },
        { "note.md": "THEIRS\n", "yours.md": "yours\n" },
      );
      const result = await service.rebaseOnto({
        theirs: upstream,
        holder: "ours",
      });
      expect(calls).toEqual(["note.md:ours"]);
      expect(result).toMatchObject({
        status: "rebased",
        merged: [{ commit: local, path: "note.md", overwritten: ["lost"] }],
      });
      expect(note(a)).toBe("THEIRS\nOURS\n");
      expect(readFileSync(join(a.repo.repoPath, "yours.md"), "utf8")).toBe(
        "yours\n",
      );
      expect(readFileSync(join(a.repo.repoPath, "mine.md"), "utf8")).toBe(
        "mine\n",
      );
    });

    it("fast-forwards, leaving an uncommitted edit alone", async () => {
      const upstream = await b.commitFiles(
        { "note.md": "new\n", "other.md": "o\n" },
        "up",
      );
      await runGit(b.repo.repoPath, ["push", "-q", "origin", "main"]);
      await a.service.fetchRefs(remote, [{ ref: MAIN, oid: upstream }]);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(a.repo.repoPath, "note.md"), "typing…\n");

      const result = await a.service.rebaseOnto({ theirs: upstream });
      expect(result).toEqual({
        status: "fast-forward",
        oid: upstream,
        skippedDirty: ["note.md"],
      });
      expect(note(a)).toBe("typing…\n");
      expect(readFileSync(join(a.repo.repoPath, "other.md"), "utf8")).toBe(
        "o\n",
      );
      expect(await a.service.rebaseOnto({ theirs: upstream })).toEqual({
        status: "up-to-date",
        oid: upstream,
      });
    });
  });

  it("Basic auth through the auth port; without it, AuthRequired", async () => {
    const secured = await createRemoteFixture({
      basicAuth: { username: "x-access-token", password: "s3cret" },
    });
    try {
      const securedRemote = { url: secured.url, credential: "test-remote" };
      const anon = new IsomorphicGitService(
        new NodeGitStorageHost(a.repo.repoPath),
        a.repo,
        {
          http: nodeHttpClient(),
        },
      );
      await expect(
        anon.listRemoteRefs(securedRemote, [MAIN]),
      ).rejects.toMatchObject({
        code: "AuthRequired",
      });
      const authed = new IsomorphicGitService(
        new NodeGitStorageHost(a.repo.repoPath),
        a.repo,
        {
          http: nodeHttpClient(),
          auth: createBasicAuthProvider({
            "test-remote": { username: "x-access-token", password: "s3cret" },
          }),
        },
      );
      const refs = await authed.listRemoteRefs(securedRemote, [MAIN]);
      expect(refs.map((r) => r.ref)).toEqual([MAIN]);
    } finally {
      await secured.cleanup();
    }
  });
});

describeGit("HTTP status → GitError", () => {
  let servers: TestServer[] = [];
  let clone: LocalClone;
  let fixture: RemoteFixture;

  beforeAll(async () => {
    fixture = await createRemoteFixture();
    clone = await cloneFixture(fixture, "status", {
      http: nodeHttpClient(500),
    });
  });
  afterAll(async () => {
    await fixture.cleanup();
  });
  afterEach(async () => {
    await Promise.all(servers.map((s) => s.close()));
    servers = [];
  });

  async function remoteAnswering(status: number | "hang"): Promise<GitRemote> {
    const server = await startFakeServer(status);
    servers.push(server);
    return { url: `${server.url}/repo.git` };
  }

  it.each([
    [401, "AuthRequired"],
    [403, "AuthFailed"],
    [429, "Throttled"],
    [503, "Network"],
  ])("HTTP %i → %s", async (status, code) => {
    const remote = await remoteAnswering(status);
    const error = await clone.service
      .listRemoteRefs(remote, [MAIN])
      .catch((e) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error.code).toBe(code);
  });

  it("an unreachable remote → Network", async () => {
    const server = await startFakeServer(200);
    const url = `${server.url}/repo.git`;
    await server.close();
    await expect(
      clone.service.listRemoteRefs({ url }, [MAIN]),
    ).rejects.toMatchObject({
      code: "Network",
    });
  });

  it("a push whose reply never arrives → PushOutcomeUnknown", async () => {
    const remote = await remoteAnswering("hang");
    // Seed the capability cache from the real backend's advertisement, so
    // the hang hits the receive-pack POST itself.
    const real = { url: fixture.url };
    const main = (await bareRef(fixture, MAIN))!;
    const blob = await clone.service.writeBlob(encode("p"));
    await clone.service.pushRefs(real, [
      { ref: LEASE, old: ZERO_OID, new: blob },
    ]);
    const hanging = new IsomorphicGitService(
      new NodeGitStorageHost(clone.repo.repoPath),
      clone.repo,
      {
        http: {
          request: (req) =>
            req.method === "GET"
              ? nodeHttpClient().request({
                  ...req,
                  url: req.url.replace(remote.url, real.url),
                })
              : nodeHttpClient(300).request(req),
        },
      },
    );
    const error = await hanging
      .pushRefs(remote, [{ ref: MAIN, old: main, new: main }])
      .catch((e) => e);
    expect(error).toMatchObject({
      name: "GitError",
      code: "PushOutcomeUnknown",
    });
  });

  it("a push answered with a 502 → PushOutcomeUnknown; a 403 → AuthFailed", async () => {
    for (const [status, code] of [
      [502, "PushOutcomeUnknown"],
      [403, "AuthFailed"],
    ] as const) {
      const remote = await remoteAnswering(status);
      const service = new IsomorphicGitService(
        new NodeGitStorageHost(clone.repo.repoPath),
        clone.repo,
        {
          http: {
            request: (req) =>
              req.method === "GET"
                ? nodeHttpClient().request({
                    ...req,
                    url: req.url.replace(remote.url, fixture.url),
                  })
                : nodeHttpClient().request(req),
          },
        },
      );
      const main = (await bareRef(fixture, MAIN))!;
      await expect(
        service.pushRefs(remote, [
          { ref: "refs/heads/x", old: ZERO_OID, new: main },
        ]),
      ).rejects.toMatchObject({ code });
    }
  });
});
