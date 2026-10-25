import { afterEach, describe, expect, it } from "vitest";
import type { KvApi } from "@/modules/kv";
import { memoryUrlState } from "@/testing/test-core";
import { testKv } from "@/testing/test-kv";
import { trackSession } from "./session";

const settle = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
});

async function track(kv: KvApi, initialSearch = "") {
  const url = memoryUrlState(initialSearch);
  stop = trackSession(kv, url);
  await settle(20);
  return url;
}

describe("trackSession", () => {
  it("restores the last search on a bare boot", async () => {
    const kv = testKv();
    await kv.write("session", "lastSearch", "?layout=saved");
    const url = await track(kv);
    expect(url.search()).toBe("?layout=saved");
  });

  it("falls back to where settings used to keep it", async () => {
    const kv = testKv();
    await kv.write("settings", "lastSearch", "?layout=legacy");
    const url = await track(kv);
    expect(url.search()).toBe("?layout=legacy");
  });

  it("leaves a URL that already names a session alone", async () => {
    const kv = testKv();
    await kv.write("session", "lastSearch", "?layout=saved");
    const url = await track(kv, "?layout=opened");
    expect(url.search()).toBe("?layout=opened");
  });

  it("saves the URL it opens with, even if it never changes", async () => {
    const kv = testKv();
    await kv.write("session", "lastSearch", "?layout=old");
    await track(kv, "?layout=opened");
    await settle(20);
    expect(await kv.read("session", "lastSearch")).toBe("?layout=opened");
  });

  it("records each change, and never into settings", async () => {
    const kv = testKv();
    const url = await track(kv);
    url.setSearch("?layout=one");
    url.setSearch("?layout=two");
    await settle(20);
    expect(await kv.read("session", "lastSearch")).toBe("?layout=two");
    expect(await kv.read("settings", "lastSearch")).toBeUndefined();
  });

  it("records nothing before the restore, so the bare boot URL never wins", async () => {
    const kv = testKv();
    await kv.write("session", "lastSearch", "?layout=saved");
    await track(kv);
    expect(await kv.read("session", "lastSearch")).toBe("?layout=saved");
  });
});
