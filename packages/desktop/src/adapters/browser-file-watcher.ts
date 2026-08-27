import type {
  FsChangeEvent,
  FsChangeListener,
  MetadataChangeEvent,
  ContentChangeEvent,
  MetadataChange,
  ContentChange,
  IgnoreRulesOption,
} from "./platform-adapter.interface";
import { calculateContentHash } from "@/utils/hash";

interface FileSnapshot {
  path: string;
  type: "file" | "directory";
  modifiedAt: number;
  contentHash?: string;
}

interface AppWrite {
  path: string;
  contentHash: string;
  timestamp: number;
}

interface MetadataWatchState {
  watchId: string;
  paths: string[];
  ignore?: IgnoreRulesOption;
  snapshot: Map<string, FileSnapshot>;
  intervalId: number;
}

interface ContentWatchState {
  watchId: string;
  paths: string[];
  snapshot: Map<string, FileSnapshot>;
  intervalId: number;
}

const METADATA_POLL_INTERVAL = 5000;
const CONTENT_POLL_INTERVAL = 3000;
const APP_WRITE_TTL = 10000;

export class BrowserFileWatcher {
  private eventListeners: Set<FsChangeListener> = new Set();
  private metadataWatchers: Map<string, MetadataWatchState> = new Map();
  private contentWatchers: Map<string, ContentWatchState> = new Map();
  private appWrites: AppWrite[] = [];

  constructor(
    private readDirectory: (
      path: string,
      options?: {
        recursive?: boolean;
        includeFiles?: boolean;
        includeDirectories?: boolean;
        ignore?: IgnoreRulesOption;
      },
    ) => Promise<{ ok: true; value: string[] } | { ok: false; error: unknown }>,
    private readFiles: (paths: string[]) => Promise<{
      succeeded: { path: string; content: string }[];
      failed: unknown[];
    }>,
    private getMetadata: (paths: string[]) => Promise<{
      succeeded: {
        path: string;
        type: "file" | "directory";
        modifiedAt: Date;
      }[];
      failed: unknown[];
    }>,
  ) {}

  registerAppWrite(path: string, contentHash: string): void {
    const now = Date.now();
    this.appWrites = this.appWrites.filter(
      (w) => now - w.timestamp < APP_WRITE_TTL,
    );

    this.appWrites.push({
      path,
      contentHash,
      timestamp: now,
    });
  }

  private consumeAppWrite(path: string, contentHash: string): boolean {
    const now = Date.now();
    this.appWrites = this.appWrites.filter(
      (w) => now - w.timestamp < APP_WRITE_TTL,
    );

    const index = this.appWrites.findIndex(
      (w) => w.path === path && w.contentHash === contentHash,
    );

    if (index !== -1) {
      this.appWrites.splice(index, 1);
      return true;
    }
    return false;
  }

  onFsEvent(listener: FsChangeListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  private emit(event: FsChangeEvent): void {
    this.eventListeners.forEach((callback) => callback(event));
  }

  async startWatchingMetadata(
    paths: string[],
    watchId: string,
    // allowHiddenSubtrees is Tauri-only: the browser walkers never dot-filter.
    options?: { ignore?: IgnoreRulesOption; allowHiddenSubtrees?: string[] },
  ): Promise<void> {
    this.stopWatching(watchId);

    const snapshot = await this.takeMetadataSnapshot(paths, options?.ignore);

    const state: MetadataWatchState = {
      watchId,
      paths,
      ignore: options?.ignore,
      snapshot,
      intervalId: window.setInterval(() => {
        this.pollMetadataChanges(watchId);
      }, METADATA_POLL_INTERVAL),
    };

    this.metadataWatchers.set(watchId, state);
    console.log(
      `[BrowserFileWatcher] Started metadata watching: ${watchId}`,
      paths,
    );
  }

  private async takeMetadataSnapshot(
    directoryPaths: string[],
    ignore?: IgnoreRulesOption,
  ): Promise<Map<string, FileSnapshot>> {
    const snapshot = new Map<string, FileSnapshot>();

    for (const dirPath of directoryPaths) {
      const result = await this.readDirectory(dirPath, {
        recursive: true,
        includeFiles: true,
        includeDirectories: true,
        ignore,
      });

      if (!result.ok) {
        console.warn(
          `[BrowserFileWatcher] Failed to read directory: ${dirPath}`,
        );
        continue;
      }

      const paths = result.value;

      const metadataResult = await this.getMetadata(paths);

      for (const meta of metadataResult.succeeded) {
        snapshot.set(meta.path, {
          path: meta.path,
          type: meta.type,
          modifiedAt: meta.modifiedAt.getTime(),
        });
      }
    }

    return snapshot;
  }

  private async pollMetadataChanges(watchId: string): Promise<void> {
    const state = this.metadataWatchers.get(watchId);
    if (!state) return;

    try {
      const newSnapshot = await this.takeMetadataSnapshot(
        state.paths,
        state.ignore,
      );
      const changes = this.diffMetadataSnapshots(state.snapshot, newSnapshot);

      if (changes.length > 0) {
        console.log(`[BrowserFileWatcher] Metadata changes detected:`, changes);
        state.snapshot = newSnapshot;

        const event: MetadataChangeEvent = { changes };
        this.emit({ type: "fs-metadata-changed", payload: event });
      }
    } catch (error) {
      console.error(`[BrowserFileWatcher] Error polling metadata:`, error);
    }
  }

  private diffMetadataSnapshots(
    oldSnapshot: Map<string, FileSnapshot>,
    newSnapshot: Map<string, FileSnapshot>,
  ): MetadataChange[] {
    const changes: MetadataChange[] = [];

    for (const [path, oldEntry] of oldSnapshot) {
      if (!newSnapshot.has(path)) {
        changes.push({
          type: "deleted",
          path,
          isDirectory: oldEntry.type === "directory",
        });
      }
    }

    for (const [path, newEntry] of newSnapshot) {
      if (!oldSnapshot.has(path)) {
        changes.push({
          type: "created",
          path,
          isDirectory: newEntry.type === "directory",
        });
      }
    }

    return changes;
  }

  async startWatchingContent(paths: string[], watchId: string): Promise<void> {
    const existingState = this.contentWatchers.get(watchId);

    if (existingState) {
      const oldPaths = new Set(existingState.paths);
      const newPaths = new Set(paths);

      for (const oldPath of oldPaths) {
        if (!newPaths.has(oldPath)) {
          existingState.snapshot.delete(oldPath);
        }
      }

      const pathsToAdd = paths.filter((p) => !oldPaths.has(p));
      if (pathsToAdd.length > 0) {
        const newSnapshots = await this.takeContentSnapshot(pathsToAdd);
        for (const [path, snapshot] of newSnapshots) {
          existingState.snapshot.set(path, snapshot);
        }
      }

      existingState.paths = paths;
      console.log(
        `[BrowserFileWatcher] Updated content watching: ${watchId}`,
        paths,
      );
    } else {
      const snapshot = await this.takeContentSnapshot(paths);

      const state: ContentWatchState = {
        watchId,
        paths,
        snapshot,
        intervalId: window.setInterval(() => {
          this.pollContentChanges(watchId);
        }, CONTENT_POLL_INTERVAL),
      };

      this.contentWatchers.set(watchId, state);
      console.log(
        `[BrowserFileWatcher] Started content watching: ${watchId}`,
        paths,
      );
    }
  }

  private async takeContentSnapshot(
    filePaths: string[],
  ): Promise<Map<string, FileSnapshot>> {
    const snapshot = new Map<string, FileSnapshot>();

    if (filePaths.length === 0) return snapshot;

    const result = await this.readFiles(filePaths);

    for (const file of result.succeeded) {
      const contentHash = calculateContentHash(file.content);
      snapshot.set(file.path, {
        path: file.path,
        type: "file",
        modifiedAt: Date.now(),
        contentHash,
      });
    }

    return snapshot;
  }

  private async pollContentChanges(watchId: string): Promise<void> {
    const state = this.contentWatchers.get(watchId);
    if (!state || state.paths.length === 0) return;

    try {
      const result = await this.readFiles(state.paths);
      const changes: ContentChange[] = [];

      for (const file of result.succeeded) {
        const contentHash = calculateContentHash(file.content);
        const oldSnapshot = state.snapshot.get(file.path);

        if (!oldSnapshot || oldSnapshot.contentHash !== contentHash) {
          if (this.consumeAppWrite(file.path, contentHash)) {
            state.snapshot.set(file.path, {
              path: file.path,
              type: "file",
              modifiedAt: Date.now(),
              contentHash,
            });
            continue;
          }

          changes.push({
            path: file.path,
            content: file.content,
            contentHash,
          });

          state.snapshot.set(file.path, {
            path: file.path,
            type: "file",
            modifiedAt: Date.now(),
            contentHash,
          });
        }
      }

      if (changes.length > 0) {
        console.log(
          `[BrowserFileWatcher] Content changes detected:`,
          changes.map((c) => c.path),
        );
        const event: ContentChangeEvent = { changes };
        this.emit({ type: "fs-content-changed", payload: event });
      }
    } catch (error) {
      console.error(`[BrowserFileWatcher] Error polling content:`, error);
    }
  }

  stopWatching(watchId: string): void {
    const metadataState = this.metadataWatchers.get(watchId);
    if (metadataState) {
      clearInterval(metadataState.intervalId);
      this.metadataWatchers.delete(watchId);
      console.log(`[BrowserFileWatcher] Stopped metadata watching: ${watchId}`);
    }

    const contentState = this.contentWatchers.get(watchId);
    if (contentState) {
      clearInterval(contentState.intervalId);
      this.contentWatchers.delete(watchId);
      console.log(`[BrowserFileWatcher] Stopped content watching: ${watchId}`);
    }
  }
}
