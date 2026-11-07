/**
 * What makes a workspace a sync workspace, and what sync reads from the
 * user's own repo to turn it on. Pure parsing plus the few fs reads around
 * it; nothing here loads the engine.
 *
 * `<ws>/.notefig/sync.json` is local to one clone and never committed
 * (`.notefig/` sits in `.git/info/exclude`). Its presence makes the
 * workspace a sync workspace. Every clone has its own `deviceId`, so two
 * clones open in one app are two devices.
 */
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { APP_DIR_NAME } from "@/utils/app-dir";
import { path as pathutil } from "@/utils/path";

/** A commit author. */
export interface SyncAuthor {
  name: string;
  email: string;
}

/** `<ws>/.notefig/sync.json`. */
export interface SyncConfig {
  /** The remote's HTTPS URL. */
  remote: string;
  /** The branch the workspace syncs with: the one checked out. */
  branch: string;
  /** This clone's identity among the devices on the remote. */
  deviceId: string;
  /** The commit author; the repo's `user.name`/`user.email` when absent. */
  author?: SyncAuthor;
}

export const SYNC_CONFIG_FILENAME = "sync.json";

/** Where a workspace's sync config lives. */
export function syncConfigPath(workspacePath: string): string {
  return pathutil.join(
    pathutil.normalize(workspacePath),
    APP_DIR_NAME,
    SYNC_CONFIG_FILENAME,
  );
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function parseAuthor(value: unknown): SyncAuthor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { name, email } = value as Record<string, unknown>;
  return isNonEmptyString(name) && isNonEmptyString(email)
    ? { name, email }
    : undefined;
}

/** A sync.json's text as a config; null when it is not one. */
export function parseSyncConfig(text: string): SyncConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { remote, branch, deviceId, author } = raw as Record<string, unknown>;
  if (!isNonEmptyString(remote) || !isNonEmptyString(branch)) return null;
  if (!isNonEmptyString(deviceId)) return null;
  const parsedAuthor = parseAuthor(author);
  return {
    remote,
    branch,
    deviceId,
    ...(parsedAuthor ? { author: parsedAuthor } : {}),
  };
}

export function serializeSyncConfig(config: SyncConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** What reading a workspace's sync config touches. */
export type SyncConfigFs = Pick<
  FileSystemSurface,
  "readFiles" | "writeFiles" | "deleteFiles"
>;

/** The workspace's sync config; null when absent or unreadable (a
 *  regular workspace). Never throws. */
export async function readSyncConfig(
  fs: Pick<FileSystemSurface, "readFiles">,
  workspacePath: string,
): Promise<SyncConfig | null> {
  try {
    const result = await fs.readFiles([syncConfigPath(workspacePath)]);
    const file = result.succeeded[0];
    return file ? parseSyncConfig(file.content) : null;
  } catch {
    return null;
  }
}

export async function writeSyncConfig(
  fs: Pick<FileSystemSurface, "writeFiles">,
  workspacePath: string,
  config: SyncConfig,
): Promise<void> {
  const path = syncConfigPath(workspacePath);
  const result = await fs.writeFiles([
    { path, content: serializeSyncConfig(config) },
  ]);
  const failure = result.failed[0];
  if (failure) throw new Error(`Could not write ${path}: ${failure.message}`);
}

export async function deleteSyncConfig(
  fs: Pick<FileSystemSurface, "deleteFiles">,
  workspacePath: string,
): Promise<void> {
  await fs.deleteFiles([syncConfigPath(workspacePath)]);
}

/** A fresh device id: one per clone. */
export function newDeviceId(): string {
  return globalThis.crypto.randomUUID();
}

// --- The user's repo -------------------------------------------------------

/** One `[remote "name"]` section of `.git/config`. */
export interface GitConfigRemote {
  name: string;
  url: string;
}

/** What sync reads from `.git/config` and `.git/HEAD`. */
export interface RepoInfo {
  remotes: GitConfigRemote[];
  /** The checked-out branch's short name; null when HEAD is detached. */
  branch: string | null;
  /** `user.name`/`user.email` from the repo's config, when both are set. */
  author: SyncAuthor | null;
}

const SECTION = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]\s*$/;
const ENTRY = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*?))?\s*$/;

function unquote(value: string): string {
  const trimmed = value.replace(/\s+[;#].*$/, "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

/** `.git/config` as `section[.subsection]` → key → last value. */
export function parseGitConfig(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*([;#]|$)/.test(line)) continue;
    const section = SECTION.exec(line);
    if (section) {
      const name = section[1].toLowerCase();
      const key = section[2] === undefined ? name : `${name}.${section[2]}`;
      current = sections.get(key) ?? new Map();
      sections.set(key, current);
      continue;
    }
    const entry = ENTRY.exec(line);
    if (entry && current) {
      current.set(entry[1].toLowerCase(), unquote(entry[2] ?? "true"));
    }
  }
  return sections;
}

/** The remotes, branch and author sync reads from a repo's files. */
export function parseRepoInfo(configText: string, headText: string): RepoInfo {
  const sections = parseGitConfig(configText);
  const remotes: GitConfigRemote[] = [];
  for (const [key, entries] of sections) {
    if (!key.startsWith("remote.")) continue;
    const url = entries.get("url");
    if (url) remotes.push({ name: key.slice("remote.".length), url });
  }
  const user = sections.get("user");
  const name = user?.get("name");
  const email = user?.get("email");
  const head = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(headText);
  return {
    remotes,
    branch: head ? head[1] : null,
    author: name && email ? { name, email } : null,
  };
}

/** Whether sync can reach this remote: HTTPS only. */
export function isHttpsRemote(url: string): boolean {
  return /^https:\/\/[^/\s]+\/\S+/.test(url);
}

/**
 * The opaque key a remote's token is stored under, and the credential
 * reference requests carry: host plus repo path, no scheme, no `.git`, no
 * userinfo (`github.com/owner/repo`). Rust only adds the token to requests
 * whose URL is under this key.
 */
export function remoteCredentialKey(url: string): string {
  const parsed = new URL(url);
  const repoPath = parsed.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
  return `${parsed.host.toLowerCase()}${repoPath}`;
}

/** The remote URL with any userinfo dropped: what sync talks to. */
export function cleanRemoteUrl(url: string): string {
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/** Read `.git/config` and `.git/HEAD`; null when the workspace has no
 *  `.git` folder of its own. Never throws. */
export async function readRepoInfo(
  fs: Pick<FileSystemSurface, "readFiles">,
  workspacePath: string,
): Promise<RepoInfo | null> {
  const gitDir = pathutil.join(pathutil.normalize(workspacePath), ".git");
  try {
    const result = await fs.readFiles([
      pathutil.join(gitDir, "config"),
      pathutil.join(gitDir, "HEAD"),
    ]);
    const byName = new Map(
      result.succeeded.map((file) => [pathutil.basename(file.path), file.content]),
    );
    const config = byName.get("config");
    if (config === undefined) return null;
    return parseRepoInfo(config, byName.get("HEAD") ?? "");
  } catch {
    return null;
  }
}

/** How a host spells the Basic-auth username for a pasted token. */
export function defaultTokenUsername(url: string): string {
  const host = new URL(url).host.toLowerCase();
  if (host === "gitlab.com" || host.includes("gitlab")) return "oauth2";
  return "x-access-token";
}

/** Where to create a token for this remote, with the least it needs. */
export function tokenCreationHelp(url: string): {
  href: string | null;
  permissions: string;
} {
  const parsed = new URL(url);
  const host = parsed.host.toLowerCase();
  if (host === "github.com") {
    const [owner] = parsed.pathname.replace(/^\/+/, "").split("/");
    const params = new URLSearchParams({
      name: "Notefig sync",
      description: `Notefig sync for ${remoteCredentialKey(url)}`,
      ...(owner ? { target_name: owner } : {}),
      contents: "write",
    });
    return {
      href: `https://github.com/settings/personal-access-tokens/new?${params}`,
      permissions:
        'A fine-grained token for this repository only, with "Contents: Read and write". Nothing else.',
    };
  }
  if (host === "gitlab.com" || host.includes("gitlab")) {
    const params = new URLSearchParams({
      name: "Notefig sync",
      scopes: "read_repository,write_repository",
    });
    return {
      href: `https://${parsed.host}/-/user_settings/personal_access_tokens?${params}`,
      permissions:
        'A token with only "read_repository" and "write_repository". A project access token for this project alone is narrower still.',
    };
  }
  return {
    href: null,
    permissions:
      "A token that can read and push to this repository, and nothing else.",
  };
}
