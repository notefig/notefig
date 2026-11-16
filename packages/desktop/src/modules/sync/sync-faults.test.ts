import { describe, expect, it } from "vitest";
import { GitError } from "@notefig/git";
import { faultOf } from "./sync-engine";

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
