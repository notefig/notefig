import {
  readTextFile,
  writeTextFile,
  readFile,
  writeFile,
  readDir,
  exists,
  rename as tauriRename,
  copyFile,
  remove,
  mkdir,
  stat,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import { open } from "@tauri-apps/plugin-dialog";
import type { Content } from "tinybase";
import { isTauri } from "./platform";

export interface FileEntry {
  name: string;
  path: string;
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
  modified?: Date;
}

/**
 * Get the file extension from a file path
 */
export function getFileExtension(filePath: string): string {
  const parts = filePath.split(".");
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : "";
}

/**
 * Get the file name without extension from a file path
 */
export function getFileNameWithoutExtension(filePath: string): string {
  const fileName = filePath.split("/").pop() || filePath;
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : fileName;
}

/**
 * Get the directory path from a file path
 */
export function getDirectoryPath(filePath: string): string {
  const parts = filePath.split("/");
  return parts.slice(0, -1).join("/") || "/";
}

/**
 * Join path components
 */
export function joinPaths(...paths: string[]): string {
  return paths
    .filter((path) => path && path.length > 0)
    .map((path) => path.replace(/^\/+|\/+$/g, ""))
    .join("/")
    .replace(/\/+/g, "/");
}

/**
 * Normalize a file path by ensuring it starts with a leading slash
 * and removing duplicate slashes and trailing slashes
 */
export function normalizePath(filePath: string): string {
  if (!filePath) return "/";

  let normalized = filePath
    .replace(/\\/g, "/") // Convert backslashes to forward slashes
    .replace(/\/+/g, "/"); // Remove duplicate slashes

  // Ensure leading slash
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }

  // Remove trailing slash unless it's the root
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

/**
 * Mock implementation of pickDirectory for web/non-Tauri environments
 * Returns a promise that resolves when user provides a path via prompt
 */
async function mockPickDirectory(
  pickParam?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    // For web mode, we'll trigger a custom event that the UI can listen to
    const event = new CustomEvent("mock-pick-directory", {
      detail: {
        title: pickParam || "Select Directory",
        callback: (path: string | null) => resolve(path),
      },
    });
    window.dispatchEvent(event);
  });
}

export async function pickDirectory(
  pickParam?: string,
): Promise<string | null> {
  // Use mock implementation in web environment
  if (!isTauri()) {
    return mockPickDirectory(pickParam);
  }

  // Use real Tauri dialog in Tauri environment
  const result = await open({
    title: pickParam || "Select Directory",
    directory: true,
    multiple: false,
  });

  return Array.isArray(result) ? result[0] : result;
}
