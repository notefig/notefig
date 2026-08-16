/**
 * Browser stand-in for node's `crypto`, aliased in vite.config.ts.
 *
 * isomorphic-git's packfile reader (`shasumRange`, used by
 * `readObjectPacked`) calls `crypto.createHash("sha1")` directly — a
 * node-only API — while every other hash in the library goes through a
 * browser-safe fallback. Without this shim, Vite stubs `crypto` and the
 * first packed-object read throws "createHash is not a function"; the git
 * service's catch-all maps that to CorruptRepository, so any real cloned
 * repo (loose-object-only repos never hit packs) shows "commit history
 * metadata is inconsistent" in the git panel.
 *
 * Built on the platform's own `crypto.subtle` so it adds no dependency.
 * `digest` returns a Promise where node returns a string — safe because
 * isomorphic-git's sole call site awaits the enclosing async function
 * (`const actualPayloadSha = await shasumRange(...)`), which flattens the
 * promise. If a future isomorphic-git version consumes the digest
 * synchronously, this shim must switch to a sync SHA-1.
 */
export function createHash(algorithm: string) {
  if (algorithm !== "sha1") {
    throw new Error(
      `Browser crypto shim only supports sha1, got '${algorithm}'.`,
    );
  }

  const chunks: Uint8Array[] = [];
  return {
    update(data: Uint8Array) {
      chunks.push(data);
      return this;
    },
    async digest(encoding: "hex"): Promise<string> {
      if (encoding !== "hex") {
        throw new Error(
          `Browser crypto shim only supports hex digests, got '${encoding}'.`,
        );
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const buffer = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const hash = await crypto.subtle.digest("SHA-1", buffer);
      return Array.from(new Uint8Array(hash))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    },
  };
}

export default { createHash };
