import { describe, expect, it, vi } from "vitest";
import { feedbackSubmissionSchema } from "@notefig/shared/intake";
import { testKv } from "@/testing/test-kv";
import { sendFeedback } from "./feedback";

const INTAKE = "https://intake.example";

function respondWith(status: number) {
  return vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status }));
}

describe("sendFeedback", () => {
  it("posts a valid submission to the feedback workflow", async () => {
    const fetch = respondWith(202);
    const result = await sendFeedback(
      { fetch, kv: testKv(), intakeUrl: INTAKE },
      { kind: "idea", message: "  Let me pin a document to the sidebar  " },
    );
    expect(result).toBe("sent");
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe(`${INTAKE}/v1/workflows/feedback/submissions`);
    const body = feedbackSubmissionSchema.parse(JSON.parse(String(init?.body)));
    expect(body).toMatchObject({ kind: "idea", message: "Let me pin a document to the sidebar" });
  });

  it("keeps one install id across submissions", async () => {
    const fetch = respondWith(202);
    const deps = { fetch, kv: testKv(), intakeUrl: INTAKE };
    await sendFeedback(deps, { kind: "bug", message: "First report from this install" });
    await sendFeedback(deps, { kind: "bug", message: "Second report from this install" });
    const ids = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).installId);
    expect(ids[0]).toBe(ids[1]);
  });

  it.each([
    [429, "limited"],
    [400, "invalid"],
    [500, "failed"],
  ] as const)("maps a %i response to %s", async (status, expected) => {
    const result = await sendFeedback(
      { fetch: respondWith(status), kv: testKv(), intakeUrl: INTAKE },
      { kind: "other", message: "Something to tell you about" },
    );
    expect(result).toBe(expected);
  });

  it("reports a network error as failed", async () => {
    const offline = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("offline");
    });
    const result = await sendFeedback(
      { fetch: offline, kv: testKv(), intakeUrl: INTAKE },
      { kind: "bug", message: "This will not get through" },
    );
    expect(result).toBe("failed");
  });
});
