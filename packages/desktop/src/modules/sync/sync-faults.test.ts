import { describe, expect, it } from "vitest";
import { GitError } from "@notefig/git";
import { faultOf } from "./sync-engine";
import { INITIAL_SYNC_STATE, transition, type SyncState } from "./sync-machine";

describe("sync: what a failure stops on", () => {
  const ssh = "git@github.com:team/notes.git";

  it("stops on what only the user can fix over SSH, and says how", () => {
    expect(faultOf(new GitError("AuthRequired", "401"), ssh)).toEqual({
      type: "failed",
      fault: "auth-error",
      detail: expect.stringContaining("ssh-add"),
    });
    expect(faultOf(new GitError("HostUnverified", "495"), ssh)).toMatchObject({
      fault: "auth-error",
      detail: expect.stringContaining("ssh -T git@github.com"),
    });
    expect(faultOf(new GitError("UnsupportedOperation", "501"), ssh)).toMatchObject({ fault: "auth-error" });
  });

  it("waits out an unreachable SSH host, as it does an HTTPS one", () => {
    expect(faultOf(new GitError("Network", "down"), ssh)).toMatchObject({ fault: "offline" });
    expect(faultOf(new GitError("Network", "down"), "https://github.com/team/notes.git")).toMatchObject({ fault: "offline" });
  });

  it("keeps the HTTPS wording for HTTPS remotes", () => {
    expect(faultOf(new GitError("AuthRequired", "No credentials"), "https://github.com/team/notes.git")).toEqual({
      type: "failed",
      fault: "auth-error",
      detail: "No credentials",
    });
  });
});

describe("sync: who it shows while stopped", () => {
  it("forgets the devices it saw once it stops for the user", () => {
    const shared: SyncState = { ...INITIAL_SYNC_STATE, setup: "on", peers: [{ deviceId: "b", name: "Bob", colour: "#000", cursor: null, claims: [] }] };
    const summary = { since: null, localFiles: [], remoteFiles: [], people: [] };
    expect(transition(shared, { type: "diverged", detail: "rewritten" }).peers).toEqual([]);
    expect(transition(shared, { type: "paused", detail: "away", summary }).peers).toEqual([]);
  });
});
