import { describe, it, expect } from "vitest";
import { PermissionBroker } from "../permission-broker";
import type { RequestPermissionRequest } from "@metrists/shared/agent";

function req(title: string): RequestPermissionRequest {
  return {
    sessionId: "sess_test",
    toolCall: { toolCallId: "c1", title },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  } as RequestPermissionRequest;
}

describe("PermissionBroker", () => {
  it("resolves the awaited promise when the matching request is answered", async () => {
    const broker = new PermissionBroker();
    const pending = broker.request(req("one"));

    let head: { id: string } | undefined;
    const unsub = broker.subscribe((list) => (head = list[0]));
    unsub();

    broker.respond(head!.id, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
    await expect(pending).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("queues multiple requests and exposes them in order", () => {
    const broker = new PermissionBroker();
    broker.request(req("one"));
    broker.request(req("two"));
    let snapshot: { request: RequestPermissionRequest }[] = [];
    broker.subscribe((list) => (snapshot = list))();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0].request.toolCall.title).toBe("one");
    expect(snapshot[1].request.toolCall.title).toBe("two");
  });

  it("cancelAll resolves every pending request as cancelled", async () => {
    const broker = new PermissionBroker();
    const a = broker.request(req("a"));
    const b = broker.request(req("b"));
    broker.cancelAll();
    await expect(a).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(b).resolves.toEqual({ outcome: { outcome: "cancelled" } });

    let snapshot: unknown[] = [];
    broker.subscribe((list) => (snapshot = list))();
    expect(snapshot).toHaveLength(0);
  });

  it("ignores responses to unknown ids", () => {
    const broker = new PermissionBroker();
    expect(() =>
      broker.respond("perm_999", {
        outcome: { outcome: "selected", optionId: "allow" },
      }),
    ).not.toThrow();
  });
});
