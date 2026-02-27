import { useState, useCallback, useRef } from "react";
import { isTauri } from "@/utils/platform";

export type UpdaterStatus =
  | "idle"
  | "checking"
  | "available"
  | "up-to-date"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateProgress {
  downloaded: number;
  total: number | null;
}

export interface UpdateInfo {
  version: string;
  body: string | undefined;
}

export function useUpdater() {
  const [status, setStatus] = useState<UpdaterStatus>("idle");
  const [progress, setProgress] = useState<UpdateProgress>({
    downloaded: 0,
    total: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  // Holds the Update object returned by check() so we can download later.
  // useRef persists across renders without causing re-renders.
  const pendingUpdateRef = useRef<Awaited<
    ReturnType<Awaited<typeof import("@tauri-apps/plugin-updater")>["check"]>
  > | null>(null);

  const checkForUpdate = useCallback(async () => {
    if (!isTauri()) {
      setStatus("up-to-date");
      return;
    }

    try {
      setStatus("checking");
      setError(null);

      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();

      if (update) {
        pendingUpdateRef.current = update;
        setUpdateInfo({
          version: update.version,
          body: update.body ?? undefined,
        });
        setStatus("available");
      } else {
        setStatus("up-to-date");
      }
    } catch (err) {
      console.error("[Updater] Check failed:", err);
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!isTauri() || !pendingUpdateRef.current) {
      return;
    }

    try {
      setStatus("downloading");
      setError(null);
      setProgress({ downloaded: 0, total: null });

      await pendingUpdateRef.current.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            setProgress({
              downloaded: 0,
              total: event.data.contentLength ?? null,
            });
            break;
          case "Progress":
            setProgress((prev) => ({
              ...prev,
              downloaded: prev.downloaded + (event.data.chunkLength ?? 0),
            }));
            break;
          case "Finished":
            break;
        }
      });

      setStatus("ready");
    } catch (err) {
      console.error("[Updater] Download failed:", err);
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  const relaunch = useCallback(async () => {
    if (!isTauri()) return;

    try {
      const { relaunch: doRelaunch } = await import(
        "@tauri-apps/plugin-process"
      );
      await doRelaunch();
    } catch (err) {
      console.error("[Updater] Relaunch failed:", err);
      setError(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }, []);

  return {
    status,
    progress,
    error,
    updateInfo,
    checkForUpdate,
    downloadAndInstall,
    relaunch,
  };
}
