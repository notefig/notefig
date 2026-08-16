import { describe, expect, it } from "vitest";
import { createHash } from "../node-crypto";

describe("browser node-crypto shim", () => {
  it("computes the same sha1 node's crypto would (chunked updates)", async () => {
    // shasumRange feeds the hash in chunks — verify incremental updates
    // accumulate. echo -n "abc" | shasum
    const hash = createHash("sha1");
    hash.update(new TextEncoder().encode("a"));
    hash.update(new TextEncoder().encode("bc"));
    await expect(hash.digest("hex")).resolves.toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  it("hashes the empty input to the well-known sha1", async () => {
    await expect(createHash("sha1").digest("hex")).resolves.toBe(
      "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    );
  });

  it("rejects algorithms the shim does not implement", () => {
    expect(() => createHash("sha256")).toThrow(/only supports sha1/);
  });
});
