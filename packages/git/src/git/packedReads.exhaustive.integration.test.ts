/**
 * Every object, read through the patched isomorphic-git (`patches/`), is
 * byte for byte what system git has: across delta chains (offset and ref
 * deltas), blobs larger than the range reader's blocks, several packs,
 * loose objects, a pack written after the pack list was cached, parallel
 * reads, and an fs without ranged reads (isomorphic-git's own path).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";

import { createIsomorphicGitFs } from "./isomorphicGitFs";
import {
  NodeGitStorageHost,
  commitViaGit,
  hasSystemGit,
  runGit,
  stubCompressionStreams,
} from "./realGit.test-helpers";

const describeRealGit = hasSystemGit ? describe : describe.skip;

interface GitObject {
  oid: string;
  type: string;
  content: Buffer;
}

/** Every object system git can see, with its type and content. */
function allObjects(repoDir: string): GitObject[] {
  const out = spawnSync("git", ["cat-file", "--batch-all-objects", "--batch", "--unordered"], {
    cwd: repoDir,
    maxBuffer: 1 << 30,
  });
  if (out.status !== 0) throw new Error(out.stderr.toString());
  const buffer = out.stdout;
  const objects: GitObject[] = [];
  let at = 0;
  while (at < buffer.length) {
    const eol = buffer.indexOf(10, at);
    const [oid, type, size] = buffer.subarray(at, eol).toString().split(" ");
    const start = eol + 1;
    objects.push({ oid, type, content: Buffer.from(buffer.subarray(start, start + Number(size))) });
    at = start + Number(size) + 1;
  }
  return objects;
}

/** Counts what a storage host reads. */
class CountingHost extends NodeGitStorageHost {
  wholePacks = 0;
  ranged = 0;

  override async readFile(path: string): Promise<Uint8Array> {
    if (String(path).endsWith(".pack")) this.wholePacks++;
    return super.readFile(path);
  }

  override async readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    this.ranged++;
    return super.readFileRange(path, start, end);
  }
}

const shuffle = <T>(items: T[], seed: number): T[] => {
  const copy = [...items];
  let state = seed;
  for (let i = copy.length - 1; i > 0; i--) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

/** A history with long delta chains, renames, binary and large blobs. */
async function buildHistory(repoDir: string): Promise<void> {
  await runGit(repoDir, ["init", "-q", "-b", "main"]);
  // Packs only where a test makes them: a background gc a commit starts
  // would race the test's own repack.
  await runGit(repoDir, ["config", "gc.auto", "0"]);
  await runGit(repoDir, ["config", "maintenance.auto", "false"]);
  const doc = Array.from({ length: 600 }, (_, i) => `line ${i} of a document that keeps changing`);
  const large = Buffer.from(randomBytes(400 * 1024).toString("base64")); // ~530 KB, > 4 blocks
  for (let round = 0; round < 30; round++) {
    doc[(round * 37) % doc.length] = `round ${round} changed this line`;
    doc.splice((round * 13) % doc.length, 0, `inserted in round ${round}`);
    await writeFile(join(repoDir, "doc.md"), doc.join("\n"));
    large.write(`round-${round}`, (round * 9973) % (large.length - 16));
    await writeFile(join(repoDir, "large.txt"), large);
    await writeFile(join(repoDir, `notes-${round % 7}.md`), `# Notes ${round}\n${"text ".repeat(50 + round)}\n`);
    if (round % 5 === 0) await writeFile(join(repoDir, `blob-${round}.bin`), randomBytes(3000 + round * 100));
    if (round === 12) await runGit(repoDir, ["mv", "notes-3.md", "renamed-notes.md"]);
    await runGit(repoDir, ["add", "-A"]);
    await commitViaGit(repoDir, `round ${round}`);
  }
}

/** Reads `oid` as isomorphic-git does for the app, through `fs`. */
async function readThrough(fs: unknown, repoDir: string, oid: string, cache: object) {
  const { type, object } = await git.readObject({
    fs: fs as never,
    dir: repoDir,
    gitdir: join(repoDir, ".git"),
    oid,
    cache,
    format: "content",
  });
  return { type, content: Buffer.from(object as Uint8Array) };
}

function expectSame(objects: GitObject[], read: { oid: string; type: string; content: Buffer }[]) {
  const byOid = new Map(read.map((entry) => [entry.oid, entry]));
  for (const object of objects) {
    const ours = byOid.get(object.oid);
    expect(ours?.type).toBe(object.type);
    // Not toEqual on the buffers: a mismatch would print megabytes.
    expect(ours?.content.equals(object.content) ? object.oid : `differs: ${object.oid}`).toBe(object.oid);
  }
}

describeRealGit("[real-git] every packed object, read by range", () => {
  let repoDir: string;
  let restoreCompressionStreams: () => void;

  beforeAll(() => {
    restoreCompressionStreams = stubCompressionStreams();
  });

  afterAll(() => {
    restoreCompressionStreams();
  });

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "notefig-git-exhaustive-"));
    await buildHistory(repoDir);
  }, 120_000);

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  /** Read every object, in a shuffled order, with one shared cache. */
  async function readAll(seed: number, fs: unknown) {
    const objects = allObjects(repoDir);
    const cache = {};
    const read = [];
    for (const { oid } of shuffle(objects, seed)) read.push({ oid, ...(await readThrough(fs, repoDir, oid, cache)) });
    return { objects, read };
  }

  it.each([
    ["one aggressive pack (deep offset-delta chains)", ["gc", "-q", "--aggressive"]],
    ["ref deltas instead of offset deltas", ["-c", "repack.useDeltaBaseOffset=false", "repack", "-a", "-d", "-f", "-q", "--depth=50"]],
    ["deltas against far bases (large window)", ["repack", "-a", "-d", "-f", "-q", "--window=250", "--depth=250"]],
  ])("matches git for every object: %s", async (_name, repack) => {
    await runGit(repoDir, repack);
    const host = new CountingHost(repoDir);
    const { objects, read } = await readAll(7, createIsomorphicGitFs(host));
    expect(objects.length).toBeGreaterThan(150);
    expectSame(objects, read);
    expect(host.wholePacks).toBe(0);
    expect(host.ranged).toBeGreaterThan(0);
  }, 120_000);

  it("matches git across several packs and loose objects", async () => {
    await runGit(repoDir, ["gc", "-q"]);
    // A second pack of newer objects, then a few left loose.
    await writeFile(join(repoDir, "second.md"), "in the second pack\n".repeat(200));
    await runGit(repoDir, ["add", "-A"]);
    await commitViaGit(repoDir, "second pack");
    await runGit(repoDir, ["repack", "-d", "-q"]);
    await writeFile(join(repoDir, "loose.md"), "left loose\n");
    await runGit(repoDir, ["add", "-A"]);
    await commitViaGit(repoDir, "loose");
    const packs = nodeFs.readdirSync(join(repoDir, ".git", "objects", "pack")).filter((name) => name.endsWith(".pack"));
    expect(packs.length).toBeGreaterThanOrEqual(2);

    const host = new CountingHost(repoDir);
    const { objects, read } = await readAll(11, createIsomorphicGitFs(host));
    expectSame(objects, read);
    expect(host.wholePacks).toBe(0);
  }, 120_000);

  it("finds an object in a pack written after the pack list was cached", async () => {
    await runGit(repoDir, ["gc", "-q"]);
    const fs = createIsomorphicGitFs(new CountingHost(repoDir));
    const cache = {};
    const head = await runGit(repoDir, ["rev-parse", "HEAD"]);
    await readThrough(fs, repoDir, head, cache); // lists the packs

    // A pack only, never loose: as a fetch writes one.
    await writeFile(join(repoDir, "fetched.md"), "arrived in a new pack\n");
    await runGit(repoDir, ["add", "-A"]);
    await commitViaGit(repoDir, "fetched");
    await runGit(repoDir, ["repack", "-d", "-q"]);
    const blob = await runGit(repoDir, ["rev-parse", "HEAD:fetched.md"]);
    expect(nodeFs.existsSync(join(repoDir, ".git", "objects", blob.slice(0, 2), blob.slice(2)))).toBe(false);

    const { type, content } = await readThrough(fs, repoDir, blob, cache);
    expect(type).toBe("blob");
    expect(content.toString()).toBe("arrived in a new pack\n");
  }, 120_000);

  it("matches git when every object is read at once, sharing blocks", async () => {
    await runGit(repoDir, ["gc", "-q", "--aggressive"]);
    const objects = allObjects(repoDir);
    const fs = createIsomorphicGitFs(new CountingHost(repoDir));
    const cache = {};
    const read = await Promise.all(
      shuffle(objects, 3).map(async ({ oid }) => ({ oid, ...(await readThrough(fs, repoDir, oid, cache)) })),
    );
    expectSame(objects, read);
  }, 120_000);

  it("matches git with a cold cache for each object", async () => {
    await runGit(repoDir, ["gc", "-q", "--aggressive"]);
    const objects = shuffle(allObjects(repoDir), 5).slice(0, 60);
    const read = [];
    for (const { oid } of objects) {
      read.push({ oid, ...(await readThrough(createIsomorphicGitFs(new CountingHost(repoDir)), repoDir, oid, {})) });
    }
    expectSame(objects, read);
  }, 120_000);

  it("still matches git through an fs without ranged reads (the whole pack)", async () => {
    await runGit(repoDir, ["gc", "-q", "--aggressive"]);
    const { objects, read } = await readAll(13, nodeFs);
    expectSame(objects, read);
  }, 120_000);
});
