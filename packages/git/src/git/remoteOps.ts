/**
 * The remote operations over the local repo. Polling and fetching are
 * isomorphic-git's (`listServerRefs`, `fetch`) over our http port; push is
 * our own receive-pack over a `GitTransport`, for the per-ref
 * compare-and-swap leases need. Pure mechanism: no timers, polling or
 * retries — those are the caller's.
 */
import git, { type HttpClient, type PromiseFsClient } from "isomorphic-git";

import { objectsToPush } from "./repo/pushObjects";
import { joinPath, type RepoContext } from "./repo/repoContext";
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
  type GitRemoteRef,
  ZERO_OID,
} from "./types";

const OID = /^[0-9a-f]{40}$/;

/** isomorphic-git's view of one remote: our http port, and its URL. */
export interface IsomorphicRemote {
  http: HttpClient;
  url: string;
}

/**
 * The remote's refs under any of `prefixes` (all refs when empty). One
 * request: the v1 advertisement lists every ref and is filtered here.
 * Protocol v2 filters on the server but costs a capability round trip
 * first, and `listServerRefs` takes one prefix per call.
 */
export async function listRemoteRefs(
  remote: IsomorphicRemote,
  prefixes: string[],
): Promise<GitRemoteRef[]> {
  const refs = await git.listServerRefs({ ...remote, protocolVersion: 1 });
  return refs
    .filter(
      ({ ref }) =>
        prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p)),
    )
    .map(({ ref, oid }) => ({ ref, oid }));
}

async function hasObject(ctx: RepoContext, oid: string): Promise<boolean> {
  try {
    await git.readObject({ ...ctx.git, oid, format: "deflated" });
    return true;
  } catch {
    return false;
  }
}

const FETCH_REMOTE = "notefig-fetch";
const FETCH_SECTION = `\n[remote "${FETCH_REMOTE}"]\n\tfetch = +refs/notefig-fetch/none/*:refs/notefig-fetch/none/*\n`;

/**
 * isomorphic-git's `fetch` refuses a remote with no fetch refspec in the
 * config, and writes whatever refs the refspec maps. It is shown one that
 * maps nothing (we point `localRef`s ourselves), through this fs only: the
 * repo's config file is never written.
 */
function fetchFs(ctx: RepoContext): PromiseFsClient {
  const { promises } = ctx.git.fs as PromiseFsClient;
  const configPath = `${ctx.git.gitdir}/config`;
  return {
    promises: {
      ...promises,
      async readFile(path: string, options?: unknown) {
        if (path !== configPath) return promises.readFile(path, options);
        const config = await promises
          .readFile(path, { encoding: "utf8" })
          .catch(() => "");
        return `${config}${FETCH_SECTION}`;
      },
    },
  };
}

function packObjectCount(pack: Uint8Array): number {
  return new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);
}

function isMissingRef(error: unknown, ref: string): boolean {
  const { name, data } = error as { name?: string; data?: { what?: string } };
  return name === "NotFoundError" && data?.what === ref;
}

/**
 * One ref through isomorphic-git's `fetch` (singleBranch: the ref
 * advertisement, then one upload-pack POST), telling the remote we have
 * `have` (a ref or oid). Null when the remote has no such ref.
 */
async function fetchOne(
  ctx: RepoContext,
  remote: IsomorphicRemote,
  ref: string,
  have: string,
): Promise<{ oid: string; objectCount: number } | null> {
  let result;
  try {
    result = await git.fetch({
      ...ctx.git,
      ...remote,
      fs: fetchFs(ctx),
      remote: FETCH_REMOTE,
      ref: have,
      remoteRef: ref,
      singleBranch: true,
      tags: false,
      corsProxy: "",
    });
  } catch (error) {
    if (isMissingRef(error, ref)) return null;
    throw error;
  }
  const oid = result.fetchHead;
  if (!oid) return null;
  if (!(await hasObject(ctx, oid))) {
    throw new GitError(
      "RemoteError",
      `The remote didn't send ${oid} (${ref}).`,
    );
  }
  // Where it stored the pack (`objects/pack/…`): returned, though untyped.
  const { packfile } = result as { packfile?: string };
  const pack = packfile
    ? await ctx.host.readFile(joinPath(ctx.git.gitdir, packfile))
    : null;
  return { oid, objectCount: pack ? packObjectCount(pack) : 0 };
}

export async function fetchRefs(
  ctx: RepoContext,
  remote: IsomorphicRemote,
  refs: GitFetchRef[],
  options: GitFetchRefsOptions = {},
): Promise<GitFetchRefsResult> {
  for (const ref of refs) {
    if (ref.oid !== undefined && !OID.test(ref.oid)) {
      throw new GitError("InvalidInput", `Not an object id: ${ref.oid}`);
    }
  }
  // isomorphic-git takes one have, as a ref or oid; ZERO_OID resolves to
  // nothing, for an explicit empty list.
  const have = options.haves ? (options.haves[0] ?? ZERO_OID) : "HEAD";
  const found: GitFetchRefsResult["refs"] = [];
  const missing: string[] = [];
  let objectCount = 0;
  for (const { ref, oid: known, localRef } of refs) {
    if (known && (await hasObject(ctx, known))) {
      found.push({ ref, oid: known, localRef });
      continue;
    }
    const fetched = await fetchOne(ctx, remote, ref, have);
    if (!fetched) {
      missing.push(ref);
      continue;
    }
    objectCount += fetched.objectCount;
    found.push({ ref, oid: fetched.oid, localRef });
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
