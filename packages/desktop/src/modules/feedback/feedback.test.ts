import { describe, expect, it, vi } from "vitest";
import { createFeedback, messageLength } from "@/modules/feedback";

const SUPPORT_URL = "https://support.notefig.com";

const respond = (status: number) =>
  vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

function sentBody(fetchFn: typeof fetch) {
  const [url, init] = vi.mocked(fetchFn).mock.calls[0];
  const form = init?.body as FormData;
  return {
    url: String(url),
    init,
    form,
    body: JSON.parse(String(form.get("feedback"))),
  };
}

/** Object URLs without a browser: `blob:1`, `blob:2`… */
function fakeObjectUrls() {
  let next = 0;
  const revoked: string[] = [];
  return {
    revoked,
    createObjectURL: () => `blob:${++next}`,
    revokeObjectURL: (url: string) => void revoked.push(url),
  };
}

const png = (label: string) => new Blob([label], { type: "image/png" });
/** Stands in for the canvas: tags the image so a test can tell it was encoded. */
const encodeImage = async (image: Blob) =>
  new Blob(["encoded:", await image.text()], { type: "image/webp" });

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

  it("sends the images the message shows as files, and lets them go once sent", async () => {
    const fetchFn = respond(202);
    const objectUrls = fakeObjectUrls();
    const feedback = createFeedback({
      supportUrl: SUPPORT_URL,
      fetchFn,
      encodeImage,
      objectUrls,
    });
    const first = feedback.addImage(png("one"));
    const second = feedback.addImage(png("two"));
    feedback.addImage(png("deleted from the message"));

    await feedback.send({
      message: `Look ![](${first}) and ![a](${second}) and ![](${first})`,
    });

    const { form, body } = sentBody(fetchFn);
    expect(body.message).toBe(
      "Look ![](attachment:img1) and ![a](attachment:img2) and ![](attachment:img1)",
    );
    const img1 = form.get("img1") as File;
    expect(img1.type).toBe("image/webp");
    expect(await img1.text()).toBe("encoded:one");
    expect(await (form.get("img2") as File).text()).toBe("encoded:two");
    expect(form.get("img3")).toBeNull();
    expect(objectUrls.revoked).toEqual(["blob:1", "blob:2", "blob:3"]);
  });

  it("keeps a failed send's images for the retry", async () => {
    const objectUrls = fakeObjectUrls();
    const feedback = createFeedback({
      supportUrl: SUPPORT_URL,
      fetchFn: respond(502),
      encodeImage,
      objectUrls,
    });
    const url = feedback.addImage(png("one"));
    expect(await feedback.send({ message: `![](${url})` })).toBe("failed");
    expect(objectUrls.revoked).toEqual([]);
  });

  it("sends at most three images, and drops ones it can't find", async () => {
    const fetchFn = respond(202);
    const feedback = createFeedback({
      supportUrl: SUPPORT_URL,
      fetchFn,
      encodeImage,
      objectUrls: fakeObjectUrls(),
    });
    const urls = [1, 2, 3, 4].map((n) => feedback.addImage(png(`${n}`)));
    const images = urls.map((url) => `![](${url})`).join(" ");
    await feedback.send({ message: `${images} ![](blob:stale)` });

    const { form, body } = sentBody(fetchFn);
    expect(body.message).toBe(
      "![](attachment:img1) ![](attachment:img2) ![](attachment:img3)  ",
    );
    expect(form.get("img4")).toBeNull();
  });

  it("sends a pasted data-URL image as a file too", async () => {
    const fetchFn = respond(202);
    const feedback = createFeedback({
      supportUrl: SUPPORT_URL,
      fetchFn,
      encodeImage,
    });
    await feedback.send({
      message: `![](data:image/png;base64,${btoa("pixels")})`,
    });
    const { form, body } = sentBody(fetchFn);
    expect(body.message).toBe("![](attachment:img1)");
    expect(await (form.get("img1") as File).text()).toBe("encoded:pixels");
  });

  it("counts an image by its placeholder, not its URL", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(10_000)}`;
    expect(messageLength(`Hi ![](${dataUrl})`)).toBe(
      "Hi ![](attachment:img0)".length,
    );
  });

  it("finds an image written with a title", async () => {
    const fetchFn = respond(202);
    const feedback = createFeedback({
      supportUrl: SUPPORT_URL,
      fetchFn,
      encodeImage,
      objectUrls: fakeObjectUrls(),
    });
    const url = feedback.addImage(png("one"));
    const dataUrl = `data:image/png;base64,${btoa("pixels")}`;
    const message = `![a](${url} "Screenshot") and ![](${dataUrl} "Pasted")`;
    expect(messageLength(message)).toBe(
      "![a](attachment:img0) and ![](attachment:img0)".length,
    );

    await feedback.send({ message });
    const { form, body } = sentBody(fetchFn);
    expect(body.message).toBe("![a](attachment:img1) and ![](attachment:img2)");
    expect(await (form.get("img2") as File).text()).toBe("encoded:pixels");
  });

  it("lets go of the images a draft no longer shows", async () => {
    const fetchFn = respond(202);
    const objectUrls = fakeObjectUrls();
    const feedback = createFeedback({
      supportUrl: SUPPORT_URL,
      fetchFn,
      encodeImage,
      objectUrls,
    });
    const kept = feedback.addImage(png("kept"));
    feedback.addImage(png("deleted"));

    feedback.releaseImages(`Look ![](${kept})`);
    expect(objectUrls.revoked).toEqual(["blob:2"]);

    await feedback.send({ message: `Look ![](${kept})` });
    expect(await (sentBody(fetchFn).form.get("img1") as File).text()).toBe(
      "encoded:kept",
    );
  });

  it("leaves image syntax inside code alone", async () => {
    const fetchFn = respond(202);
    const feedback = createFeedback({
      supportUrl: SUPPORT_URL,
      fetchFn,
      encodeImage,
      objectUrls: fakeObjectUrls(),
    });
    const url = feedback.addImage(png("one"));
    const dataUrl = `data:image/png;base64,${"A".repeat(8)}`;
    const message = [
      `![](${url})`,
      "",
      "```md",
      "![](blob:example) and ![](" + dataUrl + ")",
      "```",
      "",
      "Inline `![](blob:inline)` too.",
    ].join("\n");

    expect(messageLength(message)).toBe(
      message.length - url.length + "attachment:img0".length,
    );
    await feedback.send({ message });
    const { form, body } = sentBody(fetchFn);
    expect(body.message).toBe(message.replace(url, "attachment:img1"));
    expect(form.get("img2")).toBeNull();
  });
});
