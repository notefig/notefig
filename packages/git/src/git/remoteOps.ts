/**
 * The remote operations, over a `GitTransport` and the local repo. Pure
 * mechanism: one call is one exchange (plus a once-per-remote capability
 * lookup for push). No timers, polling or retries — those are the caller's.
 */
import git from "isomorphic-git";

import { objectsToPush } from "./repo/pushObjects";
import { joinPath, type RepoContext } from "./repo/repoContext";
import { fetchPack } from "./smartHttp/fetchPack";
import { lsRefs } from "./smartHttp/lsRefs";
import {
  chooseCapabilities,
  parseAdvertisedCapabilities,
  receivePack,
} from "./smartHttp/receivePack";
import type { GitTransport } from "./smartHttp/transport";
import {
  GitError,
  type GitFetchRef,
  type GitFetchRefsOptions,
  type GitFetchRefsResult,
  type GitPushRefsOptions,
  type GitPushRefsResult,
  type GitRefUpdate,
  ZERO_OID,
} from "./types";

const OID = /^[0-9a-f]{40}$/;

async function hasObject(ctx: RepoContext, oid: string): Promise<boolean> {
  try {
    await git.readObject({ ...ctx.git, oid, format: "deflated" });
    return true;
  } catch {
    return false;
  }
}

/** Local branch and remote-tracking tips: what a fetch can say it has. */
async function localTips(ctx: RepoContext): Promise<string[]> {
  const tips = new Set<string>();
  for (const prefix of ["refs/heads", "refs/remotes"]) {
    const names = await git
      .listRefs({ ...ctx.git, filepath: prefix })
      .catch(() => []);
    for (const name of names) {
      const oid = await git
        .resolveRef({ ...ctx.git, ref: `${prefix}/${name}` })
        .catch(() => null);
      if (oid) tips.add(oid);
    }
  }
  return [...tips];
}

function packObjectCount(pack: Uint8Array): number {
  return new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);
}

/** Write a received pack under `objects/pack` and index it. */
async function storePack(ctx: RepoContext, pack: Uint8Array): Promise<number> {
  const count = packObjectCount(pack);
  if (count === 0) return 0;
  const sha = Array.from(pack.subarray(pack.length - 20), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  const packDir = joinPath(ctx.git.gitdir, "objects/pack");
  const packPath = joinPath(packDir, `pack-${sha}.pack`);
  await ctx.host.createDir(packDir);
  await ctx.host.writeFileAtomic(packPath, pack);
  try {
    await git.indexPack({
      ...ctx.git,
      dir: packDir,
      filepath: `pack-${sha}.pack`,
    });
  } catch (error) {
    await ctx.host.deleteFile(packPath).catch(() => undefined);
    throw error;
  }
  return count;
}

/** Fill in oids the caller didn't already know, with one `ls-refs`. */
async function resolveFetchRefs(transport: GitTransport, refs: GitFetchRef[]) {
  const unknown = refs.filter((r) => !r.oid).map((r) => r.ref);
  const listed = unknown.length > 0 ? await lsRefs(transport, unknown) : [];
  const remote = new Map(listed.map((r) => [r.ref, r.oid]));
  const found: GitFetchRefsResult["refs"] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const oid = ref.oid ?? remote.get(ref.ref);
    if (oid) found.push({ ref: ref.ref, oid, localRef: ref.localRef });
    else missing.push(ref.ref);
  }
  return { found, missing };
}

export async function fetchRefs(
  ctx: RepoContext,
  transport: GitTransport,
  refs: GitFetchRef[],
  options: GitFetchRefsOptions = {},
): Promise<GitFetchRefsResult> {
  for (const ref of refs) {
    if (ref.oid !== undefined && !OID.test(ref.oid)) {
      throw new GitError("InvalidInput", `Not an object id: ${ref.oid}`);
    }
  }
  const { found, missing } = await resolveFetchRefs(transport, refs);
  const wants: string[] = [];
  for (const oid of new Set(found.map((r) => r.oid))) {
    if (!(await hasObject(ctx, oid))) wants.push(oid);
  }
  let objectCount = 0;
  if (wants.length > 0) {
    const haves = options.haves ?? (await localTips(ctx));
    objectCount = await storePack(
      ctx,
      await fetchPack(transport, wants, haves),
    );
  }
  for (const { localRef, oid } of found) {
    if (localRef)
      await git.writeRef({
        ...ctx.git,
        ref: localRef,
        value: oid,
        force: true,
      });
  }
  return { refs: found, missing, objectCount };
}

function validateUpdates(updates: GitRefUpdate[]): void {
  if (updates.length === 0) {
    throw new GitError("InvalidInput", "pushRefs needs at least one update.");
  }
  for (const update of updates) {
    if (
      !OID.test(update.old) ||
      !OID.test(update.new) ||
      !update.ref.startsWith("refs/")
    ) {
      throw new GitError(
        "InvalidInput",
        `Bad ref update: ${JSON.stringify(update)}`,
      );
    }
  }
}

/** Per-remote receive-pack capabilities, looked up once per service. */
export type CapabilityCache = Map<string, Promise<Set<string>>>;

async function receivePackCapabilities(
  transport: GitTransport,
  cache: CapabilityCache,
  key: string,
): Promise<Set<string>> {
  let caps = cache.get(key);
  if (!caps) {
    caps = transport
      .advertise("git-receive-pack")
      .then(parseAdvertisedCapabilities);
    cache.set(key, caps);
    caps.catch(() => cache.delete(key));
  }
  return caps;
}

export async function pushRefs(
  ctx: RepoContext,
  transport: GitTransport,
  caps: { cache: CapabilityCache; key: string },
  updates: GitRefUpdate[],
  options: GitPushRefsOptions = {},
): Promise<GitPushRefsResult> {
  validateUpdates(updates);
  const advertised = await receivePackCapabilities(
    transport,
    caps.cache,
    caps.key,
  );
  const capabilities = chooseCapabilities(
    advertised,
    updates,
    options.atomic ?? false,
  );
  const tips = updates.map((u) => u.new).filter((oid) => oid !== ZERO_OID);
  let pack: Uint8Array | null = null;
  if (tips.length > 0) {
    const haves = [
      ...updates.map((u) => u.old),
      ...(options.haves ?? []),
    ].filter((oid) => oid !== ZERO_OID);
    const oids = await objectsToPush(ctx, tips, haves);
    pack = (await git.packObjects({ ...ctx.git, oids })).packfile!;
  }
  return receivePack(transport, { updates, capabilities, pack });
}
