/**
 * Packed objects are read a range at a time (the isomorphic-git patch in
 * `patches/`): reading one object never moves the whole pack through the
 * storage host, and what comes back is what system git has.
 */
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IsomorphicGitService } from "./isomorphicGitService";
import {
  NodeGitStorageHost,
  commitViaGit,
  hasSystemGit,
  runGit,
  stubCompressionStreams,
} from "./realGit.test-helpers";

const describeRealGit = hasSystemGit ? describe : describe.skip;

/** A host that counts what it reads, whole and in ranges. */
class CountingHost extends NodeGitStorageHost {
  whole: string[] = [];
  ranged = 0;
  rangedBytes = 0;

  override async readFile(path: string): Promise<Uint8Array> {
    this.whole.push(String(path));
    return super.readFile(path);
  }

  override async readFileRange(path: string, start: number, end: number): Promise<Uint8Array> {
    this.ranged++;
    const data = await super.readFileRange(path, start, end);
    this.rangedBytes += data.byteLength;
    return data;
  }
}

describeRealGit("[real-git] packed object reads", () => {
  let repoDir: string;
  let restoreCompressionStreams: () => void;

  beforeAll(() => {
    restoreCompressionStreams = stubCompressionStreams();
  });

  afterAll(() => {
    restoreCompressionStreams();
  });

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), "notefig-git-packed-"));
    await runGit(repoDir, ["init", "-q", "-b", "main"]);
    await runGit(repoDir, ["config", "gc.auto", "0"]);
    await runGit(repoDir, ["config", "maintenance.auto", "false"]);
    // Many files, so the pack outweighs any one object; one edited across
    // commits, so the pack holds deltas.
    for (let i = 0; i < 300; i++) {
      await writeFile(join(repoDir, `note-${i}.md`), `# Note ${i}\n\n${"filler text ".repeat(200)}${i}\n`);
    }
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    for (let round = 0; round < 5; round++) {
      lines[round * 50] = `edited in round ${round}`;
      await writeFile(join(repoDir, "doc.md"), lines.join("\n"));
      await runGit(repoDir, ["add", "-A"]);
      await commitViaGit(repoDir, `round ${round}`);
    }
    await runGit(repoDir, ["gc", "-q", "--aggressive"]);
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it("reads history and files from a pack without loading it whole", async () => {
    const host = new CountingHost(repoDir);
    const service = new IsomorphicGitService(host, { repoPath: repoDir, gitDir: join(repoDir, ".git") });

    const log = await service.log({ depth: 10 });
    expect(log.map((entry) => entry.commit.message.trim())).toEqual([4, 3, 2, 1, 0].map((r) => `round ${r}`));
    for (const entry of log) {
      const ours = await service.readTextFile({ ref: entry.oid, filepath: "doc.md" });
      expect(ours).toBe(await runGit(repoDir, ["show", `${entry.oid}:doc.md`]));
    }
    expect(await service.readTextFile({ ref: log[0].oid, filepath: "note-123.md" })).toContain("123");

    const packs = await runGit(repoDir, ["count-objects", "-v"]);
    const packBytes = Number(/size-pack: (\d+)/.exec(packs)![1]) * 1024;
    expect(host.whole.filter((path) => path.endsWith(".pack"))).toEqual([]);
    expect(host.ranged).toBeGreaterThan(0);
    expect(host.rangedBytes).toBeLessThan(packBytes);
  });

  it("finds objects after a repack replaced the pack it had listed", async () => {
    const service = new IsomorphicGitService(new NodeGitStorageHost(repoDir), { repoPath: repoDir, gitDir: join(repoDir, ".git") });
    const [newest, older] = await service.log({ depth: 2 });
    expect(await service.readTextFile({ ref: newest.oid, filepath: "doc.md" })).toContain("round 4");

    await writeFile(join(repoDir, "extra.md"), "one more\n");
    await runGit(repoDir, ["add", "-A"]);
    await commitViaGit(repoDir, "extra");
    await runGit(repoDir, ["repack", "-a", "-d", "-q", "-f"]);

    expect(await service.readTextFile({ ref: older.oid, filepath: "doc.md" })).toBe(
      await runGit(repoDir, ["show", `${older.oid}:doc.md`]),
    );
    const head = await runGit(repoDir, ["rev-parse", "HEAD"]);
    expect(await service.readTextFile({ ref: head, filepath: "extra.md" })).toBe("one more\n");
  });

  it("lists the index's files without reading a tree", async () => {
    const host = new CountingHost(repoDir);
    const service = new IsomorphicGitService(host, { repoPath: repoDir, gitDir: join(repoDir, ".git") });
    const fromIndex = await service.listFiles({ index: true });
    expect(host.ranged).toBe(0);
    expect(fromIndex.sort()).toEqual((await service.listFiles()).sort());
  });

  it("refuses a pack whose trailer doesn't match its index", async () => {
    const packDir = join(repoDir, ".git", "objects", "pack");
    const file = (await readdir(packDir)).find((name) => name.endsWith(".pack"))!;
    const path = join(packDir, file);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] ^= 0xff;
    await chmod(path, 0o644);
    await writeFile(path, bytes);

    const service = new IsomorphicGitService(new NodeGitStorageHost(repoDir), { repoPath: repoDir, gitDir: join(repoDir, ".git") });
    const head = await runGit(repoDir, ["rev-parse", "HEAD"]);
    await expect(service.readTextFile({ ref: head, filepath: "doc.md" })).rejects.toThrow(/trailer mismatch/i);
  });
});
