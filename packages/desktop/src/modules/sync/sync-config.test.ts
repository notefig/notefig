import { describe, expect, it } from "vitest";
import {
  cleanRemoteUrl,
  defaultTokenUsername,
  isHttpsRemote,
  parseRepoInfo,
  parseSyncConfig,
  remoteCredentialKey,
  serializeSyncConfig,
  tokenCreationHelp,
} from "./sync-config";

describe("sync.json", () => {
  it("round-trips a config and refuses anything incomplete", () => {
    const config = {
      remote: "https://github.com/o/r.git",
      branch: "main",
      deviceId: "d-1",
      author: { name: "Ada", email: "ada@x" },
    };
    expect(parseSyncConfig(serializeSyncConfig(config))).toEqual(config);
    expect(parseSyncConfig('{"remote":"https://h/r","branch":"main"}')).toBeNull();
    expect(parseSyncConfig("not json")).toBeNull();
    expect(
      parseSyncConfig('{"remote":"https://h/r","branch":"main","deviceId":"d","author":{"name":"x"}}'),
    ).toEqual({ remote: "https://h/r", branch: "main", deviceId: "d" });
  });
});

describe("the user's repo", () => {
  const CONFIG = `[core]
\trepositoryformatversion = 0
[remote "origin"]
\turl = https://github.com/notefig/notes.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[remote "backup"]
\turl = git@github.com:notefig/notes.git
[user]
\tname = "Ada Lovelace" ; inline comment
\temail = ada@example.com
[branch "main"]
\tremote = origin
`;

  it("reads remotes, the checked-out branch and the author", () => {
    expect(parseRepoInfo(CONFIG, "ref: refs/heads/main\n")).toEqual({
      remotes: [
        { name: "origin", url: "https://github.com/notefig/notes.git" },
        { name: "backup", url: "git@github.com:notefig/notes.git" },
      ],
      branch: "main",
      author: { name: "Ada Lovelace", email: "ada@example.com" },
    });
    expect(parseRepoInfo("", "3f2a…detached\n").branch).toBeNull();
  });

  it("accepts HTTPS remotes only", () => {
    expect(isHttpsRemote("https://github.com/o/r.git")).toBe(true);
    expect(isHttpsRemote("git@github.com:o/r.git")).toBe(false);
    expect(isHttpsRemote("http://github.com/o/r.git")).toBe(false);
    expect(isHttpsRemote("ssh://git@github.com/o/r.git")).toBe(false);
  });

  it("keys a token by host and repo path, never by URL spelling or userinfo", () => {
    expect(remoteCredentialKey("https://github.com/o/r.git")).toBe("github.com/o/r");
    expect(remoteCredentialKey("https://user:pw@GitHub.com/o/r/")).toBe("github.com/o/r");
    expect(remoteCredentialKey("https://git.example.com:8443/team/notes")).toBe(
      "git.example.com:8443/team/notes",
    );
    expect(cleanRemoteUrl("https://user:pw@github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  it("knows each host's token username and where to make a token", () => {
    expect(defaultTokenUsername("https://github.com/o/r.git")).toBe("x-access-token");
    expect(defaultTokenUsername("https://gitlab.com/g/p.git")).toBe("oauth2");
    const github = tokenCreationHelp("https://github.com/notefig/notes.git");
    expect(github.href).toContain("github.com/settings/personal-access-tokens/new");
    expect(github.href).toContain("target_name=notefig");
    expect(github.href).toContain("contents=write");
    const gitlab = tokenCreationHelp("https://gitlab.com/g/p.git");
    expect(gitlab.href).toContain("scopes=read_repository%2Cwrite_repository");
    expect(tokenCreationHelp("https://git.example.com/a/b").href).toBeNull();
  });
});
