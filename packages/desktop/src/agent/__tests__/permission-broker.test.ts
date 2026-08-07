import { describe, it, expect, beforeEach } from "vitest";
import { PermissionBroker } from "../permission-broker";
import { agentPermissionRequestsCollection } from "../agent-collections";
import type { RequestPermissionRequest } from "@notefig/shared/agent";

function req(title: string): RequestPermissionRequest {
  return {
    sessionId: "sess_test",
    toolCall: { toolCallId: "c1", title },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  } as RequestPermissionRequest;
}

function rowsFor(taskId: string) {
  return agentPermissionRequestsCollection.toArray
    .filter((r) => r.taskId === taskId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

beforeEach(() => {
  for (const r of agentPermissionRequestsCollection.toArray) {
    agentPermissionRequestsCollection.delete(r.id);
  }
});

describe("PermissionBroker", () => {
  it("publishes a pending row and resolves the awaited promise on answer", async () => {
    const broker = new PermissionBroker("task_1");
    const pending = broker.request(req("one"));

    const head = rowsFor("task_1")[0];
    expect(head.status).toBe("pending");
    expect(head.title).toBe("one");

    broker.respond(head.id, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
    await expect(pending).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
    // Row is no longer pending, so the UI query drops it.
    expect(agentPermissionRequestsCollection.get(head.id)?.status).toBe(
      "granted",
    );
  });

  it("queues multiple requests, exposed in order via the collection", () => {
    const broker = new PermissionBroker("task_2");
    broker.request(req("one"));
    broker.request(req("two"));
    const rows = rowsFor("task_2");
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("one");
    expect(rows[1].title).toBe("two");
  });

  it("cancelAll resolves every pending request as cancelled", async () => {
    const broker = new PermissionBroker("task_3");
    const a = broker.request(req("a"));
    const b = broker.request(req("b"));
    broker.cancelAll();
    await expect(a).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(b).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    expect(rowsFor("task_3").every((r) => r.status === "cancelled")).toBe(true);
  });

  it("ignores responses to unknown ids", () => {
    const broker = new PermissionBroker("task_4");
    expect(() =>
      broker.respond("task_4_perm_999", {
        outcome: { outcome: "selected", optionId: "allow" },
      }),
    ).not.toThrow();
  });
});
