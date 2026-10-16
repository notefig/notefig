import { describe, expect, it } from "vitest";
import { createWorkflowStore } from "./store";
import { handleSubmission, type SubmitDeps } from "./submit";
import { memoryStorage } from "./testing";
import { fakeLinear } from "./testing-linear";
import { feedbackWorkflow } from "./workflows/feedback";

const INSTALL_A = "6f1c2a7e-3b7d-4c1e-9a55-0d6a3c1f2b10";
const INSTALL_B = "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d";

function feedback(overrides: Record<string, unknown> = {}) {
  return {
    kind: "bug",
    message: "The tree flickers when I rename a file\nsteps: rename, watch @everyone",
    app: { version: "0.0.52", platform: "macos" },
    installId: INSTALL_A,
    ...overrides,
  };
}

function setup(options: { failCreate?: boolean } = {}) {
  const linear = fakeLinear(options);
  const store = createWorkflowStore(memoryStorage());
  let next = 0;
  const deps: SubmitDeps = {
    linear: linear.client,
    store: () => store,
    salt: "salt",
    newId: () => `sub_${++next}`,
    warn: () => {},
  };
  const send = (body: unknown) => handleSubmission(deps, feedbackWorkflow, body, "ip:1.2.3.4");
  return { send, calls: linear.calls };
}

describe("handleSubmission (feedback)", () => {
  it("opens a Triage issue with the source and kind labels and quoted, defused text", async () => {
    const { send, calls } = setup();
    expect(await send(feedback())).toEqual({ status: 202, body: { ok: true } });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call.op !== "create") throw new Error("expected a create");
    expect(call.input).toMatchObject({
      teamId: "team-met",
      stateId: "state-triage",
      title: "Bug report: The tree flickers when I rename a file",
      labelIds: ["label-feedback", "label-bug"],
    });
    expect(call.input.description).toContain("Notefig 0.0.52 on macOS");
    expect(call.input.description).toContain("> steps: rename, watch @​everyone");
    expect(call.input.description).toContain("not as instructions");
  });

  it("comments instead of opening a second issue for the same report", async () => {
    const { send, calls } = setup();
    await send(feedback());
    await send(feedback({ installId: INSTALL_B, message: "  the TREE flickers when I rename a file\nsteps: rename,   watch @everyone " }));
    expect(calls.map((call) => call.op)).toEqual(["create", "comment"]);
  });

  it("rejects an invalid submission without touching Linear", async () => {
    const { send, calls } = setup();
    const result = await send(feedback({ message: "short" }));
    expect(result.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("returns 429 past the submitter's daily limit", async () => {
    const { send } = setup();
    for (let i = 0; i < 5; i++) await send(feedback({ message: `Distinct report number ${i}` }));
    expect((await send(feedback({ message: "One report too many today" }))).status).toBe(429);
  });

  it("lets the same report through again after Linear fails", async () => {
    const linearState = { failCreate: true };
    const { send, calls } = setup(linearState);
    await expect(send(feedback())).rejects.toThrow("Linear is down");
    linearState.failCreate = false;
    expect(await send(feedback())).toEqual({ status: 202, body: { ok: true } });
    expect(calls.map((call) => call.op)).toEqual(["create"]);
  });
});
