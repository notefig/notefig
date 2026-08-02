/**
 * App-side ignore rules for workspace scanning.
 *
 * Single source of truth: the Rust commands (read_directory, search,
 * metadata watcher) receive these lists via command args, so there is no
 * Rust-side copy to drift. Filtering is opt-in per call — the git storage
 * host (adapters' getGitStorageHost) never passes them, so git sees the
 * complete tree including .git internals and dependency folders.
 *
 * Denylist, not allowlist: unknown and extensionless files (LICENSE,
 * Makefile) stay tracked. Names like `dist`/`build` could collide with a
 * writer's real folders — the list is deliberately one editable constant.
 */

import { getFileExtension } from "./fs";

export const IGNORED_DIRECTORIES: string[] = [
  "node_modules",
  "bower_components",
  "vendor",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  "venv",
  "Pods",
  "DerivedData",
];

export const IGNORED_EXTENSIONS: string[] = [
  // Archives
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "7z",
  "rar",
  // Executables / build objects
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "a",
  "class",
  "pyc",
  "wasm",
  "jar",
  // Audio / video
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  // Fonts
  "ttf",
  "otf",
  "woff",
  "woff2",
  "eot",
  // Disk images / packages / databases
  "iso",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "db",
  "sqlite",
  "sqlite3",
  "bin",
  "dat",
  // Office / design
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "psd",
  "ai",
  "sketch",
];

/** The shape adapters accept and forward to the Rust commands. */
export interface IgnoreRules {
  directories: string[];
  extensions: string[];
}

export const IGNORE_RULES: IgnoreRules = {
  directories: IGNORED_DIRECTORIES,
  extensions: IGNORED_EXTENSIONS,
};

const ignoredDirectorySet = new Set(
  IGNORED_DIRECTORIES.map((d) => d.toLowerCase()),
);
const ignoredExtensionSet = new Set(
  IGNORED_EXTENSIONS.map((e) => e.toLowerCase()),
);

/** Whether a single path component names an ignored directory. */
export function isIgnoredDirectory(name: string): boolean {
  return ignoredDirectorySet.has(name.toLowerCase());
}

/** Whether a file path has an ignored extension. Extensionless ⇒ false. */
export function isIgnoredFile(path: string): boolean {
  // getFileExtension already lowercases and returns "" for extensionless.
  const extension = getFileExtension(path);
  return extension !== "" && ignoredExtensionSet.has(extension);
}

/**
 * Whether a path is ignored: any component is an ignored directory, or the
 * final component has an ignored extension. Used as the frontend backstop
 * in file-sync (watcher events) and by the browser adapters' walks.
 *
 * Components are evaluated relative to `base` when given — the workspace
 * itself may legitimately live under a directory named like an ignored one
 * (e.g. ~/Documents/build/my-book), and only components *inside* the
 * workspace count. Mirrors the Rust hidden-filter's relative-to-base rule.
 */
export function isIgnoredPath(path: string, base?: string): boolean {
  let relative = path;
  if (base) {
    const prefix = base.endsWith("/") ? base : base + "/";
    if (path === base) return false;
    if (path.startsWith(prefix)) relative = path.slice(prefix.length);
  }
  const components = relative.split("/").filter((c) => c.length > 0);
  if (components.length === 0) return false;
  if (components.some((c) => isIgnoredDirectory(c))) return true;
  return isIgnoredFile(components[components.length - 1]);
}
