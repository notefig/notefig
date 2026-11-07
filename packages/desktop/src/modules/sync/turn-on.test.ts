import { describe, expect, it, vi } from "vitest";
import { turnOffSync, turnOnSync } from "./turn-on";
import type { SyncResult, SyncVerifyOutcome } from "./sync-types";

const REMOTE = "https://github.com/team/notes.git";

function fakes(verified: SyncResult<SyncVerifyOutcome>, stored = false) {
  return {
    sync: {
      verify: vi.fn(async () => verified),
      enable: vi.fn(async () => {}),
    },
    credentials: {
      set: vi.fn(async () => {}),
      has: vi.fn(async () => stored),
    },
  };
}

const input = { remote: REMOTE, branch: "main", username: "x-access-token" };

describe("turnOnSync", () => {
  it("stores the token under the remote's key, checks access, then turns sync on", async () => {
    const deps = fakes({ ok: true, value: { remoteHead: "abc", canPush: true } });

    const result = await turnOnSync(deps, {
      ...input,
      token: " pat ",
      author: { name: "Ada", email: "ada@x" },
    });

    expect(result).toEqual({ ok: true });
    expect(deps.credentials.set).toHaveBeenCalledWith("github.com/team/notes", "x-access-token", "pat");
    expect(deps.sync.verify).toHaveBeenCalledWith({ remote: REMOTE, branch: "main" });
    expect(deps.sync.enable).toHaveBeenCalledWith({
      remote: REMOTE,
      branch: "main",
      author: { name: "Ada", email: "ada@x" },
    });
  });

  it("needs a token unless one is stored", async () => {
    const none = fakes({ ok: true, value: { remoteHead: null, canPush: true } });
    expect(await turnOnSync(none, { ...input, token: "" })).toEqual({
      ok: false,
      message: expect.stringContaining("Paste a token"),
    });
    expect(none.sync.enable).not.toHaveBeenCalled();

    const stored = fakes({ ok: true, value: { remoteHead: null, canPush: true } }, true);
    expect(await turnOnSync(stored, { ...input, token: "" })).toEqual({ ok: true });
    expect(stored.credentials.set).not.toHaveBeenCalled();
  });

  it("refuses a token that can read but not push", async () => {
    const deps = fakes({ ok: true, value: { remoteHead: "abc", canPush: false } });
    const result = await turnOnSync(deps, { ...input, token: "pat" });
    expect(result.ok).toBe(false);
    expect(deps.sync.enable).not.toHaveBeenCalled();
  });

  it("explains a refused or unknown repository", async () => {
    const refused = fakes({ ok: false, error: { code: "AuthFailed", message: "403" } });
    expect(await turnOnSync(refused, { ...input, token: "pat" })).toEqual({
      ok: false,
      message: expect.stringContaining("github.com/team/notes"),
    });
    const missing = fakes({ ok: false, error: { code: "RepoNotFound", message: "404" } });
    expect(await turnOnSync(missing, { ...input, token: "pat" })).toEqual({
      ok: false,
      message: expect.stringContaining("not found"),
    });
  });
});

describe("turnOffSync", () => {
  it("turns sync off, and deletes the token only when asked", async () => {
    const make = () => ({
      sync: {
        disable: vi.fn(async () => {}),
        config: () => ({ remote: REMOTE, branch: "main", deviceId: "d" }),
      },
      credentials: { delete: vi.fn(async () => {}) },
    });
    const keep = make();
    await turnOffSync(keep, { deleteToken: false });
    expect(keep.sync.disable).toHaveBeenCalled();
    expect(keep.credentials.delete).not.toHaveBeenCalled();

    const drop = make();
    await turnOffSync(drop, { deleteToken: true });
    expect(drop.credentials.delete).toHaveBeenCalledWith("github.com/team/notes");
  });
});
