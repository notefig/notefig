import { createIsomorphicGitFs } from "./isomorphicGitFs";
import type { GitStorageHost } from "./types";

const PACK = "/ws/.git/objects/pack/pack-0123456789abcdef0123456789abcdef01234567.pack";
const BLOCK = 64 * 1024;

/** A host over one file's bytes, counting ranged reads. */
function hostOver(bytes: Uint8Array) {
  const calls: [number, number][] = [];
  const host = {
    readFileRange: async (_path: string, start: number, end: number) => {
      calls.push([start, end]);
      return bytes.slice(start, end);
    },
  } as unknown as GitStorageHost;
  return { host, calls };
}

type RangeFs = { promises: { readFileRange(path: string, start: number, end: number): Promise<Uint8Array> } };

describe("createIsomorphicGitFs ranged pack reads", () => {
  const bytes = Uint8Array.from({ length: 5 * BLOCK + 123 }, (_, i) => (i * 31) % 251);

  it("returns exactly the bytes asked for, across block boundaries and at the end", async () => {
    const { host } = hostOver(bytes);
    const { promises } = createIsomorphicGitFs(host) as unknown as RangeFs;
    for (const [start, end] of [
      [0, 10],
      [BLOCK - 5, BLOCK + 5],
      [2 * BLOCK + 1, 3 * BLOCK + 2],
      [5 * BLOCK, 5 * BLOCK + 500],
    ]) {
      expect(Array.from(await promises.readFileRange(PACK, start, end))).toEqual(Array.from(bytes.slice(start, end)));
    }
  });

  it("reads neighbouring objects from one cached block", async () => {
    const { host, calls } = hostOver(bytes);
    const { promises } = createIsomorphicGitFs(host) as unknown as RangeFs;
    await promises.readFileRange(PACK, 100, 200);
    await promises.readFileRange(PACK, 200, 900);
    await promises.readFileRange(PACK, 900, 1000);
    expect(calls).toEqual([[0, BLOCK]]);
  });

  it("reads a large range, or any file but a pack, directly", async () => {
    const { host, calls } = hostOver(bytes);
    const { promises } = createIsomorphicGitFs(host) as unknown as RangeFs;
    await promises.readFileRange(PACK, 10, 5 * BLOCK);
    await promises.readFileRange("/ws/.git/index", 0, 10);
    expect(calls).toEqual([
      [10, 5 * BLOCK],
      [0, 10],
    ]);
  });
});
