import { isHttpsRemote, parseRemoteUrl, remoteLabel, sshDestination } from "./remoteUrl";

const ssh = (user: string | null, host: string, path: string, port: number | null = null) => ({ kind: "ssh", user, host, port, path });

describe("remote URLs, read as git reads them", () => {
  it.each([
    ["git@github.com:o/r.git", ssh("git", "github.com", "o/r.git")],
    ["github.com:o/r.git", ssh(null, "github.com", "o/r.git")],
    ["g:x", ssh(null, "g", "x")],
    ["[::1]:x", ssh(null, "::1", "x")],
    ["git@[::1]:x", ssh("git", "::1", "x")],
    ["host:path[1].git", ssh(null, "host", "path[1].git")],
    ["git@host:a[1]:b.git", ssh("git", "host", "a[1]:b.git")],
    ["user@host:22/r", ssh("user", "host", "22/r")],
    ["ssh://user%40x@host:22/p", ssh("user@x", "host", "/p", 22)],
    ["ssh://h/~/r", ssh(null, "h", "~/r")],
    ["ssh://[::1]:2222/r", ssh(null, "::1", "/r", 2222)],
    ["git+ssh://h/p", ssh(null, "h", "/p")],
    ["https://github.com/o/r.git", { kind: "https", host: "github.com", path: "o/r.git" }],
    ["https://gitlab.com:8443/g/sub/r", { kind: "https", host: "gitlab.com:8443", path: "g/sub/r" }],
  ])("reads %s", (url, expected) => expect(parseRemoteUrl(url)).toEqual(expected));

  it.each([
    "C:\\x",
    "C:/x",
    "[h:2222]:r",
    "ssh://h:22",
    "ssh://-oProxyCommand=x/p",
    "-oProxyCommand=x:p",
    "https://tok@github.com/o/r",
    "https://github.com",
    "http://host/r",
    "file:///srv/x.git",
    "/srv/x.git",
    "./x",
    "a/b:c",
    "host::path",
    "ext::sh -c evil",
    "host:",
    "two words:x",
  ])("isn't a remote Notefig reaches: %s", (url) => expect(parseRemoteUrl(url)).toBeNull());

  it("labels a remote the way a person reads it", () => {
    expect(remoteLabel("https://github.com/team/notes.git")).toBe("github.com/team/notes");
    expect(remoteLabel("git@github.com:team/notes.git")).toBe("github.com/team/notes");
    expect(remoteLabel("ssh://git@host:2222/~/group/sub/notes.git/")).toBe("host:2222/group/sub/notes");
    expect(remoteLabel("/srv/notes.git")).toBe("/srv/notes.git");
    expect(isHttpsRemote("https://github.com/team/notes.git")).toBe(true);
    expect(isHttpsRemote("git@github.com:team/notes.git")).toBe(false);
  });

  it.each([
    ["git@github.com:team/notes.git", "git@github.com"],
    ["git@[::1]:notes.git", "git@::1"],
    ["gh:team/notes.git", "gh"],
    ["ssh://git@host:2222/notes.git", "ssh://git@host:2222"],
    ["ssh://[::1]:2222/notes.git", "ssh://[::1]:2222"],
    ["ssh://alice%40example.com@host/x.git", "alice@example.com@host"],
    ["https://github.com/team/notes.git", null],
  ])("hands ssh a destination for %s", (url, destination) => expect(sshDestination(url)).toBe(destination));
});

describe("the SSH bridge URL", () => {
  it("hands the transport git's older ssh spellings as ssh://", async () => {
    const { sshBridgeUrl } = await import("./httpClient");
    expect(sshBridgeUrl("git+ssh://h/p")).toBe(sshBridgeUrl("ssh://h/p"));
    expect(sshBridgeUrl("ssh+git://git@h:22/p")).toBe(sshBridgeUrl("ssh://git@h:22/p"));
    expect(sshBridgeUrl("git@h:p")).toBe(`https://ssh.notefig.invalid/${encodeURIComponent("git@h:p")}`);
  });
});
