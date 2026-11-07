/**
 * The worker's presence: positions mapped between versions with the
 * merge's block alignment (a block inserted above, an edited block, a
 * deleted one), agents placed on the block they write, and every write a
 * request of its own with one ref.
 */
import { describe, expect, it, vi } from "vitest";
import { ZERO_OID, type GitService } from "@notefig/git";
import { createMarkdownCodec } from "@/components/editor/markdown-codec";
import { splitBlocks } from "../merge/blocks";
import type { SyncPresencePayload } from "../sync-types";
import {
  createPresenceCache,
  deletePresence,
  mapPayload,
  publishPresence,
  type PresenceContext,
} from "./sync-worker-presence";
import { decodePresence } from "./presence-payload";

const codec = createMarkdownCodec();
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);

const BASE = ["# Title", "", "Alpha.", "", "Beta.", "", "Gamma.", ""].join("\n");

function context(files: Record<string, string>, extra: Partial<GitService> = {}) {
  const loads = { blocks: 0 };
  const service = {
    readTextFile: vi.fn(async ({ ref, filepath }: { ref: string; filepath: string }) => {
      const text = files[`${ref}:${filepath}`];
      if (text === undefined) throw new Error("missing");
      return text;
    }),
    ...extra,
  } as unknown as GitService;
  const ctx: PresenceContext = {
    service,
    remote: { url: "https://example.test/o/r.git" },
    head: async () => C2,
    loadBlocks: async () => {
      loads.blocks += 1;
      return (markdown) => splitBlocks(codec, markdown);
    },
    cache: createPresenceCache(),
  };
  return { ctx, service, loads };
}

const payload = (cursors: SyncPresencePayload["cursors"]): SyncPresencePayload => ({
  v: 1,
  user: { name: "B", color: "#0090ff" },
  deviceId: "b",
  commit: C1,
  seq: 1,
  focused: true,
  cursors,
  agents: [],
});

const at = (blockIndex: number, offset = 2) => ({ blockIndex, offset });

describe("mapping presence positions onto the local head", () => {
  it("follows a block when one is inserted above it", async () => {
    const after = BASE.replace("Alpha.", "Inserted.\n\nAlpha.");
    const { ctx } = context({ [`${C1}:a.md`]: BASE, [`${C2}:a.md`]: after });
    const mapped = await mapPayload(ctx, payload([{ path: "a.md", anchor: at(2), head: at(3) }]), C2);
    expect(mapped.commit).toBe(C2);
    // Beta. was block 2 and Gamma. block 3; one block above them now.
    expect(mapped.cursors).toEqual([{ path: "a.md", anchor: at(3), head: at(4) }]);
  });

  it("keeps an edited block's identity", async () => {
    const after = BASE.replace("Beta.", "Beta, rewritten by someone.");
    const { ctx } = context({ [`${C1}:a.md`]: BASE, [`${C2}:a.md`]: after });
    const mapped = await mapPayload(ctx, payload([{ path: "a.md", anchor: at(2, 4) }]), C2);
    expect(mapped.cursors).toEqual([{ path: "a.md", anchor: at(2, 4) }]);
  });

  it("drops a position whose block was deleted", async () => {
    const after = BASE.replace("Beta.\n\n", "");
    const { ctx } = context({ [`${C1}:a.md`]: BASE, [`${C2}:a.md`]: after });
    const mapped = await mapPayload(
      ctx,
      payload([
        { path: "a.md", anchor: at(2) },
        { path: "a.md", anchor: at(3) },
      ]),
      C2,
    );
    // Beta. (2) is gone; Gamma. (3) is now block 2.
    expect(mapped.cursors).toEqual([{ path: "a.md", anchor: at(2) }]);
  });

  it("maps as-is when it has no version to map from, and never loads the codec for one commit", async () => {
    const { ctx, loads } = context({ [`${C2}:a.md`]: BASE });
    const same = await mapPayload(ctx, payload([{ path: "a.md", anchor: at(1) }]), C1);
    expect(same.cursors).toEqual([{ path: "a.md", anchor: at(1) }]);
    expect(loads.blocks).toBe(0);
    const missing = await mapPayload(ctx, payload([{ path: "a.md", anchor: at(1) }]), C2);
    expect(missing.cursors).toEqual([{ path: "a.md", anchor: at(1) }]);
  });

  it("aligns each pair of versions once", async () => {
    const after = BASE.replace("Alpha.", "Inserted.\n\nAlpha.");
    const { ctx, service } = context({ [`${C1}:a.md`]: BASE, [`${C2}:a.md`]: after });
    for (let i = 0; i < 5; i++) {
      await mapPayload(ctx, payload([{ path: "a.md", anchor: at(2) }]), C2);
    }
    expect(service.readTextFile).toHaveBeenCalledTimes(2);
  });
});

describe("publishing", () => {
  function publisher() {
    const blobs: Uint8Array[] = [];
    const pushes: { ref: string; old: string; new: string }[][] = [];
    const { ctx } = context(
      { [`${C2}:a.md`]: BASE },
      {
        writeBlob: vi.fn(async (bytes: Uint8Array) => {
          blobs.push(bytes);
          return "b".repeat(39) + blobs.length;
        }),
        pushRefs: vi.fn(async (_remote, updates) => {
          pushes.push(updates);
          return { ok: true, unpack: "ok", refs: [], messages: [] };
        }),
      },
    );
    return { ctx, blobs, pushes };
  }

  const draft = {
    v: 1 as const,
    user: { name: "Me", color: "#e5484d" },
    deviceId: "me",
    seq: 3,
    focused: true,
    cursors: [{ path: "a.md", anchor: at(1) }],
    agents: [
      {
        taskId: "t",
        harness: "claude",
        label: "Edit",
        status: "editing" as const,
        path: "a.md",
        snippets: ["Gamma."],
      },
    ],
  };

  it("writes one ref per request: a blob stamped with the head, the agent on its block", async () => {
    const { ctx, blobs, pushes } = publisher();
    const outcome = await publishPresence(ctx, { ref: "refs/notefig/v1/presence/me", old: null, draft });
    expect(outcome.status).toBe("published");
    expect(pushes).toEqual([
      [{ ref: "refs/notefig/v1/presence/me", old: ZERO_OID, new: expect.any(String) }],
    ]);
    const written = decodePresence(blobs[0])!;
    expect(written.commit).toBe(C2);
    expect(written.cursors).toEqual([{ path: "a.md", anchor: at(1) }]);
    expect(written.agents).toEqual([
      {
        taskId: "t",
        harness: "claude",
        label: "Edit",
        status: "editing",
        path: "a.md",
        anchor: { blockIndex: 3, offset: 1 },
      },
    ]);
  });

  it("deletes with a compare-and-swap on the last oid, alone", async () => {
    const { ctx, pushes } = publisher();
    await deletePresence(ctx, { ref: "refs/notefig/v1/presence/me", old: "c".repeat(40) });
    expect(pushes).toEqual([
      [{ ref: "refs/notefig/v1/presence/me", old: "c".repeat(40), new: ZERO_OID }],
    ]);
  });
});
