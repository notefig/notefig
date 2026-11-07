/**
 * Presence in the sync worker (MET-272): writing this device's presence
 * blob and ref, deleting it, and reading the others'. All of it off the
 * main thread, positions included: a payload's positions are relative to
 * the commit its device had, and are mapped here onto this clone's branch
 * head with the block alignment the merge uses (`merge/blocks.ts`).
 *
 * Every presence write is its own receive-pack request with exactly one
 * ref in it: GitHub refuses a whole non-atomic push when any ref in it is
 * stale, so presence never rides along with a content CAS (decision 5).
 */
import { GitError, ZERO_OID, type GitRemote, type GitService } from "@notefig/git";
import { blocksAt, createBlockCache, indexMapper, type BlockCache, type BlockContext } from "./worker-blocks";
import type { SyncBlockPosition } from "../document-channel";
import type {
  SyncPresenceAgent,
  SyncPresenceDraft,
  SyncPresencePayload,
  SyncPresencePublishOutcome,
  SyncPresenceRead,
  SyncRefTip,
} from "../sync-types";
import { decodePresence, encodePresence, PRESENCE_FORMAT_VERSION } from "./presence-payload";

export type { SplitBlocks } from "./worker-blocks";

export interface PresenceContext extends BlockContext {
  remote: GitRemote;
  /** The local branch tip. */
  head(): Promise<string | null>;
}

/** Splits and alignments per version (shared with leases). */
export type PresenceCache = BlockCache;
export const createPresenceCache = createBlockCache;

type Mapper = (position: SyncBlockPosition) => SyncBlockPosition | null;

/** Positions of `path` at `from`, mapped onto `to`. A version this clone
 *  lacks (a commit not fetched yet) maps as-is: the next poll fixes it. */
async function mapperFor(
  ctx: PresenceContext,
  path: string,
  from: string | null,
  to: string | null,
): Promise<Mapper> {
  const map = await indexMapper(ctx, path, from, to);
  return (position) => {
    const blockIndex = map(position.blockIndex);
    return blockIndex === null ? null : { blockIndex, offset: position.offset };
  };
}

/** A payload with its positions mapped onto `head`; positions whose block
 *  is gone are dropped. */
export async function mapPayload(
  ctx: PresenceContext,
  payload: SyncPresencePayload,
  head: string | null,
): Promise<SyncPresencePayload> {
  const mappers = new Map<string, Promise<Mapper>>();
  const mapper = (path: string) => {
    let found = mappers.get(path);
    if (!found) {
      found = mapperFor(ctx, path, payload.commit, head);
      mappers.set(path, found);
    }
    return found;
  };
  const cursors: SyncPresencePayload["cursors"] = [];
  for (const cursor of payload.cursors) {
    const map = await mapper(cursor.path);
    const anchor = map(cursor.anchor);
    if (!anchor) continue;
    const moved = cursor.head ? map(cursor.head) : null;
    cursors.push({ path: cursor.path, anchor, ...(moved ? { head: moved } : {}) });
  }
  const agents: SyncPresenceAgent[] = [];
  for (const agent of payload.agents) {
    if (!agent.path || !agent.anchor) {
      agents.push(agent);
      continue;
    }
    const anchor = (await mapper(agent.path))(agent.anchor);
    const { anchor: _old, ...rest } = agent;
    agents.push(anchor ? { ...rest, anchor } : rest);
  }
  return { ...payload, commit: head, cursors, agents };
}

const MIN_SNIPPET = 3;

/** The block of `path` at `head` holding one of `snippets` (text an agent
 *  is writing or replacing), by its first non-blank line. */
async function blockOfSnippet(
  ctx: PresenceContext,
  head: string | null,
  path: string,
  snippets: string[],
): Promise<SyncBlockPosition | null> {
  if (!head || snippets.length === 0) return null;
  const blocks = await blocksAt(ctx, head, path);
  if (!blocks) return null;
  for (const snippet of snippets) {
    const line = snippet
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length >= MIN_SNIPPET);
    if (!line) continue;
    const index = blocks.findIndex((block) => block.includes(line));
    if (index >= 0) return { blockIndex: index, offset: 1 };
  }
  return null;
}

/** The payload to publish: the draft stamped with the branch head, agents
 *  placed on the block they are writing. */
async function payloadOf(
  ctx: PresenceContext,
  draft: SyncPresenceDraft,
): Promise<SyncPresencePayload> {
  const head = await ctx.head();
  const agents: SyncPresenceAgent[] = [];
  for (const { snippets, ...agent } of draft.agents) {
    const anchor = agent.path
      ? await blockOfSnippet(ctx, head, agent.path, snippets ?? []).catch(() => null)
      : null;
    agents.push(anchor ? { ...agent, anchor } : agent);
  }
  return { ...draft, v: PRESENCE_FORMAT_VERSION, commit: head, agents };
}

/** Write the presence blob and point this device's ref at it: one ref,
 *  one request, a CAS against `old`. */
export async function publishPresence(
  ctx: PresenceContext,
  input: { ref: string; old: string | null; draft: SyncPresenceDraft },
): Promise<SyncPresencePublishOutcome> {
  const payload = await payloadOf(ctx, input.draft);
  const blob = await ctx.service.writeBlob(encodePresence(payload));
  if (blob === input.old) return { status: "published", oid: blob };
  try {
    const result = await ctx.service.pushRefs(ctx.remote, [
      { ref: input.ref, old: input.old ?? ZERO_OID, new: blob },
    ]);
    return result.ok ? { status: "published", oid: blob } : { status: "rejected" };
  } catch (error) {
    if (error instanceof GitError && error.code === "PushOutcomeUnknown") {
      return { status: "unknown" };
    }
    throw error;
  }
}

export async function deletePresence(
  ctx: PresenceContext,
  input: { ref: string; old: string },
): Promise<{ deleted: boolean }> {
  const result = await ctx.service.pushRefs(ctx.remote, [
    { ref: input.ref, old: input.old, new: ZERO_OID },
  ]);
  return { deleted: result.ok };
}

/** Fetch the blobs not here yet (one request for all of them), decode
 *  each, and map its positions onto the branch head. */
export async function readPresence(
  ctx: PresenceContext,
  refs: SyncRefTip[],
): Promise<SyncPresenceRead[]> {
  if (refs.length === 0) return [];
  await ctx.service.fetchRefs(
    ctx.remote,
    refs.map(({ ref, oid }) => ({ ref, oid })),
    { haves: [] },
  );
  const head = await ctx.head();
  const out: SyncPresenceRead[] = [];
  for (const { ref, oid } of refs) {
    const bytes = await ctx.service.readBlob(oid).catch(() => null);
    const decoded = bytes ? decodePresence(bytes) : null;
    out.push({ ref, oid, payload: decoded ? await mapPayload(ctx, decoded, head) : null });
  }
  return out;
}
