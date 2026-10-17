import { describe, expect, it, vi } from "vitest";
import { sendFeedback } from "@/utils/feedback";

const respond = (status: number) =>
  vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

describe("sendFeedback", () => {
  it("posts the feedback with the app's version and OS to /v1/feedback", async () => {
    const fetchFn = respond(202);
    const result = await sendFeedback(
      "https://support.notefig.com",
      { kind: "idea", message: "Dark mode for the sidebar" },
      fetchFn,
    );
    expect(result).toBe("sent");
    const [url, init] = vi.mocked(fetchFn).mock.calls[0];
    expect(String(url)).toBe("https://support.notefig.com/v1/feedback");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "idea",
      message: "Dark mode for the sidebar",
      version: __APP_VERSION__,
      os: "web",
    });
  });

  it("tells a rate limit apart from other failures", async () => {
    const feedback = { kind: "bug", message: "x" } as const;
    const url = "https://support.notefig.com";
    expect(await sendFeedback(url, feedback, respond(429))).toBe("rate-limited");
    expect(await sendFeedback(url, feedback, respond(502))).toBe("failed");
    expect(await sendFeedback(url, feedback, respond(400))).toBe("failed");
  });

  it("turns a network error into a failure instead of throwing", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(
      await sendFeedback(
        "https://support.notefig.com",
        { kind: "other", message: "x" },
        offline,
      ),
    ).toBe("failed");
  });
});
