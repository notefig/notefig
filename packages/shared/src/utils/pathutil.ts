/**
 * Flavor-parameterized path manipulation (MET-157 B2).
 *
 * The app's internal path representation is the OS-native one: `/`-separated
 * absolute paths on macOS/web (browser adapters use synthetic posix roots),
 * `C:\…` / `\\server\share\…` on Windows. Every path operation goes through
 * one of these flavors; the desktop runtime binds the right one once
 * (packages/desktop/src/utils/path.ts) and web/browser code stays on `posix`.
 *
 * Pure by design: no platform detection, no Date/randomness, no fs access —
 * the win32 flavor is fully unit-testable on any OS.
 *
 * Contract notes:
 * - `posix` is a behavioral identity with the pre-migration code for every
 *   input macOS/web actually produces (see the characterization suite in
 *   packages/desktop/src/utils/__tests__/path-characterization.test.ts).
 * - `toKey` is for Map/registry keys and comparisons ONLY — never for values
 *   sent to the OS, shown to users, or persisted for display. On posix it is
 *   the identity, so persisted mac keys never change spelling.
 * - `toTreePath`/`fromTreePath` convert between native *relative* paths and
 *   the intrinsically `/`-separated domains (file tree, ignore globs,
 *   isomorphic-git filepaths, mention tokens, URL segments).
 * - No cwd-relative resolution on purpose: a relative path reaching the OS
 *   is the bug class resolveWorkspacePath exists to prevent.
 */

export interface PathFlavor {
  readonly sep: "/" | "\\";
  isAbsolute(path: string): boolean;
  /** Join parts with the native separator; empty parts are skipped. Does NOT
   *  resolve `.`/`..` — containment logic must collapse explicitly. */
  join(...parts: string[]): string;
  /** Canonical native spelling: native separators, duplicate separators
   *  collapsed, trailing separator stripped (except filesystem roots).
   *  Never adds or removes absoluteness and never touches character case. */
  normalize(path: string): string;
  dirname(path: string): string;
  basename(path: string): string;
  /** Native-separator path of `path` relative to `root`, "" when equal,
   *  undefined when `path` is not under `root`. win32 compares
   *  case-insensitively and accepts mixed separators. */
  relative(root: string, path: string): string | undefined;
  contains(root: string, path: string): boolean;
  /** Comparison/registry key. posix: identity. win32: normalize + lowercase
   *  (NTFS is case-insensitive by default; casing-only distinctions don't
   *  survive the filesystem anyway). */
  toKey(path: string): string;
  /** Native relative path → `/`-separated tree-domain path. */
  toTreePath(relativePath: string): string;
  /** `/`-separated tree-domain path → native relative path. */
  fromTreePath(treePath: string): string;
  /** Native absolute path → forward-slash form (`C:/Users/…`, `//srv/sh/…`)
   *  for URIs and `/`-expecting third parties. posix: normalize only. */
  toPosixAbsolute(path: string): string;
  /** RFC 8089 file URI, per-segment percent-encoded. posix:
   *  `file:///Users/…`; win32 drive: `file:///C:/Users/…`; win32 UNC:
   *  `file://server/share/…`. */
  toFileUri(path: string): string;
}

function stripTrailing(path: string, sep: string, rootLength: number): string {
  let end = path.length;
  while (end > rootLength && path[end - 1] === sep) end--;
  return path.slice(0, end);
}

function encodeSegments(posixPath: string): string {
  // A drive-letter segment keeps its colon raw (file:///C:/… not C%3A).
  return posixPath
    .split("/")
    .map((segment) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment)))
    .join("/");
}

const POSIX_SEP = "/";

export const posix: PathFlavor = {
  sep: POSIX_SEP,

  isAbsolute(path: string): boolean {
    return path.startsWith("/");
  },

  join(...parts: string[]): string {
    const joined = parts.filter((part) => part.length > 0).join("/");
    return posix.normalize(joined);
  },

  normalize(path: string): string {
    if (!path) return path;
    // Backslash conversion matches the historical normalizePath behavior on
    // mac (a `\` in a filename was always mangled; identity is the contract).
    const collapsed = path.replace(/\\/g, "/").replace(/\/+/g, "/");
    return stripTrailing(collapsed, "/", collapsed.startsWith("/") ? 1 : 0);
  },

  dirname(path: string): string {
    const normalized = posix.normalize(path);
    const idx = normalized.lastIndexOf("/");
    if (idx < 0) return ".";
    if (idx === 0) return "/";
    return normalized.slice(0, idx);
  },

  basename(path: string): string {
    const normalized = posix.normalize(path);
    const idx = normalized.lastIndexOf("/");
    return idx < 0 ? normalized : normalized.slice(idx + 1);
  },

  relative(root: string, path: string): string | undefined {
    const normalizedRoot = stripTrailing(posix.normalize(root), "/", 1);
    const normalizedPath = posix.normalize(path);
    if (normalizedPath === normalizedRoot) return "";
    const prefix = normalizedRoot === "/" ? "/" : `${normalizedRoot}/`;
    if (!normalizedPath.startsWith(prefix)) return undefined;
    return normalizedPath.slice(prefix.length);
  },

  contains(root: string, path: string): boolean {
    return posix.relative(root, path) !== undefined;
  },

  toKey(path: string): string {
    return path;
  },

  toTreePath(relativePath: string): string {
    return relativePath;
  },

  fromTreePath(treePath: string): string {
    return treePath;
  },

  toPosixAbsolute(path: string): string {
    return posix.normalize(path);
  },

  toFileUri(path: string): string {
    return "file://" + encodeSegments(posix.normalize(path));
  },
};

/** `C:` (drive-relative, rare) is NOT absolute; `C:\` / `C:/` are. */
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC_PREFIX = /^[\\/]{2}[^\\/]/;

function toBackslashes(path: string): string {
  return path.replace(/\//g, "\\");
}

/** Length of the part of a normalized win32 path that must keep (or is) its
 *  trailing separator: `C:\` → 3, `\\` of a UNC prefix → 2, else 0. */
function win32RootLength(path: string): number {
  if (/^[A-Za-z]:\\/.test(path)) return 3;
  if (path.startsWith("\\\\")) return 2;
  return 0;
}

export const win32: PathFlavor = {
  sep: "\\",

  isAbsolute(path: string): boolean {
    return DRIVE_ABSOLUTE.test(path) || UNC_PREFIX.test(path);
  },

  join(...parts: string[]): string {
    const joined = parts.filter((part) => part.length > 0).join("\\");
    return win32.normalize(joined);
  },

  normalize(path: string): string {
    if (!path) return path;
    const backslashed = toBackslashes(path);
    // Preserve exactly the leading `\\` of a UNC path while collapsing
    // duplicates everywhere else.
    const isUnc = UNC_PREFIX.test(backslashed);
    const body = isUnc ? backslashed.slice(2) : backslashed;
    const collapsed = (isUnc ? "\\\\" : "") + body.replace(/\\+/g, "\\");
    return stripTrailing(collapsed, "\\", win32RootLength(collapsed));
  },

  dirname(path: string): string {
    const normalized = win32.normalize(path);
    const rootLength = win32RootLength(normalized);
    const idx = normalized.lastIndexOf("\\");
    if (idx < 0) return ".";
    if (idx < rootLength) return normalized.slice(0, rootLength);
    return normalized.slice(0, idx);
  },

  basename(path: string): string {
    const normalized = win32.normalize(path);
    const idx = normalized.lastIndexOf("\\");
    return idx < 0 ? normalized : normalized.slice(idx + 1);
  },

  relative(root: string, path: string): string | undefined {
    const normalizedRoot = win32.normalize(root);
    const normalizedPath = win32.normalize(path);
    const rootKey = normalizedRoot.toLowerCase();
    const pathKey = normalizedPath.toLowerCase();
    if (pathKey === rootKey) return "";
    const rootWithSep = rootKey.endsWith("\\") ? rootKey : `${rootKey}\\`;
    if (!pathKey.startsWith(rootWithSep)) return undefined;
    return normalizedPath.slice(rootWithSep.length);
  },

  contains(root: string, path: string): boolean {
    return win32.relative(root, path) !== undefined;
  },

  toKey(path: string): string {
    return win32.normalize(path).toLowerCase();
  },

  toTreePath(relativePath: string): string {
    return relativePath.replace(/\\/g, "/");
  },

  fromTreePath(treePath: string): string {
    return toBackslashes(treePath);
  },

  toPosixAbsolute(path: string): string {
    return win32.normalize(path).replace(/\\/g, "/");
  },

  toFileUri(path: string): string {
    const posixAbsolute = win32.toPosixAbsolute(path);
    if (posixAbsolute.startsWith("//")) {
      // UNC: the server becomes the URI host, the rest the encoded path.
      const [host, ...rest] = posixAbsolute.slice(2).split("/");
      return `file://${host}/${encodeSegments(rest.join("/"))}`;
    }
    return "file:///" + encodeSegments(posixAbsolute);
  },
};
