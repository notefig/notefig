/**
 * Where a widget's prompt goes (MET-163 follow-up).
 *
 * The bug this pins: a widget restored from a document sits in the composing
 * phase (its turn didn't outlive the app), so its send took the round-one
 * path and opened a NEW session — the persisted binding was written to the
 * file, shown in the UI, and then ignored by the one action that matters.
 */
import { describe, it, expect } from "vitest";
import { resolvePromptTarget } from "../ui/prompt-blob";
import { updatePromptBlob } from "../store";
import { fakePromptWidgetHost } from "../../testing/fake-host";

describe("resolvePromptTarget", () => {
  it("continues the session a restored widget is bound to", async () => {
    const host = fakePromptWidgetHost();
    updatePromptBlob("blob_restored", {
      boundTaskId: "task_previous",
      boundTurnId: null,
    });
    expect(await resolvePromptTarget(host, "blob_restored", "/ws")).toBe(
      "task_previous",
    );
    expect(host.startOrGetSharedSession).not.toHaveBeenCalled();
  });

  it("falls back to the shared session when that session is gone", async () => {
    const host = fakePromptWidgetHost({
      isTaskReachable: async () => false,
    });
    updatePromptBlob("blob_dead", {
      boundTaskId: "task_gone",
      boundTurnId: null,
    });
    expect(await resolvePromptTarget(host, "blob_dead", "/ws")).toBe(
      "task_shared",
    );
  });

  it("uses the shared session for a widget that has never been sent", async () => {
    const host = fakePromptWidgetHost();
    expect(await resolvePromptTarget(host, "blob_fresh", "/ws")).toBe(
      "task_shared",
    );
    // No binding to check, so reachability is never consulted.
    expect(host.isTaskReachable).not.toHaveBeenCalled();
  });
});
