/**
 * A git remote's URL, read the way git reads it (`url.c`, `connect.c`;
 * gitoxide's `gix-url` follows the same order):
 *
 * 1. `scheme://…` is a URL: `https` and `ssh` (also `git+ssh`, `ssh+git`)
 *    are ours, read with `URL`; any other scheme isn't.
 * 2. Otherwise a colon before any slash makes it scp-like,
 *    `[user@]host:path`, with an IPv6 host in brackets (`[::1]:path`).
 *    The split is the first colon after the host, so a path can hold
 *    colons and brackets of its own.
 * 3. Everything else is a local path (`/srv/x.git`, `./x`, `a/b:c`), and
 *    so are a drive (`C:\x`, `C:/x`, which git reads as host `C` outside
 *    Windows) and a remote helper (`host::address`).
 *
 * No regex decides what a remote is: one place does, and the transport,
 * the messages and the UI all read it from here.
 */

export type RemoteUrl =
  | { kind: "https"; host: string; path: string }
  | { kind: "ssh"; user: string | null; host: string; port: number | null; path: string };

const SSH_SCHEMES = new Set(["ssh", "git+ssh", "ssh+git"]);

/** A host, user or path ssh could take as an option, or one with a
 *  space, control character or NUL in it: refused, as git refuses them. */
function unsafe(part: string): boolean {
  if (part.startsWith("-")) return true;
  for (const char of part) if (char <= " " || char === "\u007f") return true;
  return false;
}

function sshRemote(user: string | null, host: string, port: number | null, path: string): RemoteUrl | null {
  if (!host || unsafe(host) || (user !== null && (!user || unsafe(user)))) return null;
  if (!path || path.includes("\0") || path.includes("\n")) return null;
  return { kind: "ssh", user, host, port, path };
}

/** The scheme of `scheme://…`, lowercased; null when it isn't a URL. */
function schemeOf(url: string): string | null {
  const end = url.indexOf("://");
  if (end <= 0) return null;
  const scheme = url.slice(0, end);
  const letters = /^[A-Za-z][A-Za-z0-9+.-]*$/;
  return letters.test(scheme) ? scheme.toLowerCase() : null;
}

function parsedUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function decoded(part: string): string | null {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

function fromHttps(parsed: URL): RemoteUrl | null {
  // A token in the URL would travel with every request and every log.
  if (parsed.username || parsed.password || !parsed.hostname) return null;
  const path = parsed.pathname.replace(/^\/+/, "");
  return path ? { kind: "https", host: parsed.host, path } : null;
}

function fromSshUrl(parsed: URL): RemoteUrl | null {
  if (parsed.password) return null;
  const user = parsed.username ? decoded(parsed.username) : null;
  const decodedPath = decoded(parsed.pathname);
  if ((parsed.username && user === null) || decodedPath === null) return null;
  // `ssh://host/~/x` is `~/x`, the home directory, as git reads it.
  const path = decodedPath.startsWith("/~") ? decodedPath.slice(1) : decodedPath;
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  return sshRemote(user, host, parsed.port ? Number(parsed.port) : null, path === "/" ? "" : path);
}

function fromUrl(url: string, scheme: string): RemoteUrl | null {
  const parsed = parsedUrl(url);
  if (!parsed) return null;
  if (scheme === "https") return fromHttps(parsed);
  return SSH_SCHEMES.has(scheme) ? fromSshUrl(parsed) : null;
}

/** Where the host ends in a scp-like URL: the colon after it. `[` opens
 *  an IPv6 host only where the host starts: first, or right after the
 *  user's `@`. -1 when there's no such colon. */
function scpSplit(url: string): number {
  const at = url.indexOf("@");
  const hostStart = at >= 0 && at < url.indexOf(":") && url[at + 1] === "[" ? at + 1 : 0;
  if (url[hostStart] !== "[") return url.indexOf(":");
  const close = url.indexOf("]", hostStart);
  return close >= 0 && url[close + 1] === ":" ? close + 1 : -1;
}

/** The host as ssh takes it: an IPv6 address out of its brackets. git
 *  also reads `[host:port]`, but ssh would be handed `host:port`, so only
 *  an IPv6 address (two colons or more) goes in brackets here. */
function scpHost(written: string): string | null {
  if (!written.startsWith("[")) return written;
  const host = written.slice(1, -1);
  return host.split(":").length >= 3 ? host : null;
}

function fromScp(url: string): RemoteUrl | null {
  const split = scpSplit(url);
  if (split <= 0) return null;
  const before = url.slice(0, split);
  const path = url.slice(split + 1);
  // A slash first is a local path; `::` a remote helper; `C:\`, a drive.
  if (before.includes("/") || path.startsWith(":")) return null;
  if (split === 1 && (path.startsWith("/") || path.startsWith("\\"))) return null;
  const userEnd = before.lastIndexOf("@");
  const host = scpHost(before.slice(userEnd + 1));
  if (host === null) return null;
  return sshRemote(userEnd >= 0 ? before.slice(0, userEnd) : null, host, null, path);
}

/** What `url` is as a remote Notefig can reach; null for anything else
 *  (a local path, `http://`, `file://`, a remote helper, a URL with a
 *  token in it). */
export function parseRemoteUrl(url: string): RemoteUrl | null {
  const trimmed = url.trim();
  const scheme = schemeOf(trimmed);
  return scheme ? fromUrl(trimmed, scheme) : fromScp(trimmed);
}

/** `ssh://…` or git's `[user@]host:path`. */
export function isSshRemote(url: string): boolean {
  return parseRemoteUrl(url)?.kind === "ssh";
}

/** `https://host/path`, without credentials in it. */
export function isHttpsRemote(url: string): boolean {
  return parseRemoteUrl(url)?.kind === "https";
}

/**
 * How a person reads a remote: `github.com/team/notes`. The host, then the
 * path with its leading `/` or `~/`, trailing `/` and `.git` dropped (no
 * assumption that it's `owner/repo`: GitLab nests groups). The URL as
 * written when it isn't one Notefig reaches.
 */
export function remoteLabel(url: string): string {
  const remote = parseRemoteUrl(url);
  if (!remote) return url;
  const host = remote.kind === "ssh" && remote.port ? `${remote.host}:${remote.port}` : remote.host;
  const path = remote.path.replace(/^\/+/, "").replace(/^~\//, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return `${host}/${path}`;
}

/**
 * What to hand `ssh` to reach an SSH remote, as a person would type it:
 * `[user@]host`, or `ssh://[user@]host:port` when it has a port (ssh takes
 * that form too). Null when the URL isn't an SSH remote.
 */
export function sshDestination(url: string): string | null {
  const remote = parseRemoteUrl(url);
  if (remote?.kind !== "ssh") return null;
  const user = remote.user ? `${remote.user}@` : "";
  if (!remote.port) return `${user}${remote.host}`;
  const host = remote.host.includes(":") ? `[${remote.host}]` : remote.host;
  return `ssh://${user}${host}:${remote.port}`;
}

/** The host a remote is on (`github.com`, `host:8443`), for a message;
 *  the URL as written when it isn't one Notefig reaches. */
export function remoteHost(url: string): string {
  return parseRemoteUrl(url)?.host ?? url;
}
