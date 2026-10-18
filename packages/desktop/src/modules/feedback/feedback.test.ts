import { describe, expect, it, vi } from "vitest";
import { createFeedback } from "@/modules/feedback";

const SUPPORT_URL = "https://support.notefig.com";

const respond = (status: number) =>
  vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

function sentBody(fetchFn: typeof fetch) {
  const [url, init] = vi.mocked(fetchFn).mock.calls[0];
  return { url: String(url), init, body: JSON.parse(String(init?.body)) };
}

describe("createFeedback", () => {
  it("tells subscribers when the dialog opens and closes", () => {
    const feedback = createFeedback({ supportUrl: SUPPORT_URL });
    const listener = vi.fn();
    const unsubscribe = feedback.subscribe(listener);

    feedback.open();
    feedback.open();
    expect(feedback.isOpen()).toBe(true);
    feedback.close();
    expect(feedback.isOpen()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    feedback.open();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("is unavailable, and sends nothing, without a support URL", async () => {
    const fetchFn = respond(202);
    const feedback = createFeedback({ supportUrl: undefined, fetchFn });
    expect(feedback.available).toBe(false);
    expect(await feedback.send({ message: "x" })).toBe("failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts the message with the app's version and OS to /v1/feedback", async () => {
    const fetchFn = respond(202);
    const feedback = createFeedback({ supportUrl: SUPPORT_URL, fetchFn });
    expect(await feedback.send({ message: "Dark mode for the sidebar" })).toBe(
      "sent",
    );
    const { url, init, body } = sentBody(fetchFn);
    expect(url).toBe(`${SUPPORT_URL}/v1/feedback`);
    expect(init?.method).toBe("POST");
    expect(body).toEqual({
      message: "Dark mode for the sidebar",
      version: __APP_VERSION__,
      os: "web",
    });
  });

  it("attaches the debug report, cut to what the Worker accepts", async () => {
    const fetchFn = respond(202);
    const feedback = createFeedback({ supportUrl: SUPPORT_URL, fetchFn });
    await feedback.send({ message: "x", debugReport: "r".repeat(60_000) });
    const { debugReport } = sentBody(fetchFn).body;
    expect(debugReport.length).toBeLessThanOrEqual(50_000);
    expect(debugReport.endsWith("… (truncated)")).toBe(true);
  });

  it("tells a rate limit apart from other failures", async () => {
    const send = (status: number) =>
      createFeedback({
        supportUrl: SUPPORT_URL,
        fetchFn: respond(status),
      }).send({ message: "x" });
    expect(await send(429)).toBe("rate-limited");
    expect(await send(502)).toBe("failed");
    expect(await send(400)).toBe("failed");
  });

  it("fails instead of throwing on a network error or a server that never answers", async () => {
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const hanging = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    ) as unknown as typeof fetch;
    for (const fetchFn of [offline, hanging]) {
      const feedback = createFeedback({
        supportUrl: SUPPORT_URL,
        fetchFn,
        timeoutMs: 10,
      });
      expect(await feedback.send({ message: "x" })).toBe("failed");
    }
  });
});
