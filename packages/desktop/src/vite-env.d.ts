/// <reference types="vite/client" />

/** Injected by Vite at build time from package.json version */
declare const __APP_VERSION__: string;

/** Injected by Vite at build time: raw markdown of release-notes/v<version>.md
 * for the current package.json version, or "" when the file doesn't exist. */
declare const __LATEST_RELEASE_NOTES__: string;

interface ImportMetaEnv {
  /** PostHog project key. Absent = telemetry fully disabled (dev/forks). */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog ingestion host. Defaults to https://us.i.posthog.com. */
  readonly VITE_POSTHOG_HOST?: string;
  /** Set to "shim" by the e2e shim config; also makes telemetry inert. */
  readonly VITE_TEST_BACKEND?: string;
  readonly VITE_TEST_BACKEND_PORT?: string;
}

// File System Access API types
interface FileSystemHandle {
  kind: "file" | "directory";
  name: string;
}

interface FileSystemFileHandle extends FileSystemHandle {
  kind: "file";
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle extends FileSystemHandle {
  kind: "directory";
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  keys(): AsyncIterableIterator<string>;
  values(): AsyncIterableIterator<FileSystemHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null>;
}

interface FileSystemWritableFileStream extends WritableStream {
  write(data: BufferSource | Blob | string): Promise<void>;
  seek(position: number): Promise<void>;
  truncate(size: number): Promise<void>;
}

interface Window {
  showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker(options?: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker(options?: {
    excludeAcceptAllOption?: boolean;
    suggestedName?: string;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }): Promise<FileSystemFileHandle>;
}

// Extend Navigator interface for webdriver property
declare interface Navigator {
  webdriver?: boolean;
}
