/**
 * Where a widget's prompt goes (MET-163 follow-up).
 *
 * The bug this pins: a widget restored from a document sits in the composing
 * phase (its turn didn't outlive the app), so its send took the round-one
 * path and opened a NEW session — the persisted binding was written to the
 * file, shown in the UI, and then ignored by the one action that matters.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const isReachable = vi.hoisted(() => vi.fn(async () => true));
const getOrStartSharedSession = vi.hoisted(() =>
  vi.fn(async () => ({ taskId: "task_shared" })),
);

vi.mock("@/agent/agents", () => ({
  agents: { task: () => ({ isReachable }) },
}));
vi.mock("../blob-session-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../blob-session-store")>()),
  getOrStartSharedSession,
}));

import { resolvePromptTarget } from "../prompt-blob";
import { updatePromptBlob } from "../prompt-blob-store";
import { BUILT_IN_HARNESSES } from "@notefig/shared/agent";

const harness = BUILT_IN_HARNESSES[0];

beforeEach(() => {
  isReachable.mockClear();
  getOrStartSharedSession.mockClear();
  isReachable.mockResolvedValue(true);
});

describe("resolvePromptTarget", () => {
  it("continues the session a restored widget is bound to", async () => {
    updatePromptBlob("blob_restored", {
      boundTaskId: "task_previous",
      boundTurnId: null,
    });
    expect(await resolvePromptTarget("blob_restored", "/ws", harness)).toBe(
      "task_previous",
    );
    expect(getOrStartSharedSession).not.toHaveBeenCalled();
  });

  it("falls back to the shared session when that session is gone", async () => {
    isReachable.mockResolvedValue(false);
    updatePromptBlob("blob_dead", {
      boundTaskId: "task_gone",
      boundTurnId: null,
    });
    expect(await resolvePromptTarget("blob_dead", "/ws", harness)).toBe(
      "task_shared",
    );
  });

  it("uses the shared session for a widget that has never been sent", async () => {
    expect(await resolvePromptTarget("blob_fresh", "/ws", harness)).toBe(
      "task_shared",
    );
    // No binding to check, so reachability is never consulted.
    expect(isReachable).not.toHaveBeenCalled();
  });
});
