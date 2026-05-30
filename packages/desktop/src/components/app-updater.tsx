import { useEffect, useRef } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import i18n from "@/utils/intl";
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
  body?: string;
}

export interface AppUpdaterState {
  status: UpdaterStatus;
  progress: UpdateProgress;
  error: string | null;
  updateInfo: UpdateInfo | null;
}

type PendingUpdate = Awaited<
  ReturnType<Awaited<typeof import("@tauri-apps/plugin-updater")>["check"]>
>;

export const APP_UPDATER_QUERY_KEY = ["app-updater"] as const;

const INITIAL_UPDATER_STATE: AppUpdaterState = {
  status: "idle",
  progress: {
    downloaded: 0,
    total: null,
  },
  error: null,
  updateInfo: null,
};

let pendingUpdate: PendingUpdate | null = null;

function genericErrorMessage(): string {
  return i18n.t("updaterGenericError");
}

function getStoredState(queryClient: QueryClient): AppUpdaterState {
  const existing = queryClient.getQueryData<AppUpdaterState>(
    APP_UPDATER_QUERY_KEY,
  );

  if (existing) {
    return existing;
  }

  queryClient.setQueryData(APP_UPDATER_QUERY_KEY, INITIAL_UPDATER_STATE);
  return INITIAL_UPDATER_STATE;
}

function patchState(
  queryClient: QueryClient,
  patch:
    | Partial<AppUpdaterState>
    | ((state: AppUpdaterState) => Partial<AppUpdaterState>),
) {
  queryClient.setQueryData<AppUpdaterState>(APP_UPDATER_QUERY_KEY, (prev) => {
    const current = prev ?? INITIAL_UPDATER_STATE;
    const nextPatch = typeof patch === "function" ? patch(current) : patch;
    return {
      ...current,
      ...nextPatch,
    };
  });
}

export function getAppUpdaterQueryOptions(queryClient: QueryClient) {
  const initialData = getStoredState(queryClient);

  return {
    queryKey: APP_UPDATER_QUERY_KEY,
    queryFn: async () => getStoredState(queryClient),
    initialData,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  };
}

export async function checkForUpdate(queryClient: QueryClient) {
  if (!isTauri()) {
    patchState(queryClient, {
      status: "up-to-date",
      error: null,
      updateInfo: null,
    });
    return;
  }

  patchState(queryClient, {
    status: "checking",
    error: null,
  });

  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    if (update) {
      pendingUpdate = update;

      patchState(queryClient, {
        status: "available",
        error: null,
        updateInfo: {
          version: update.version,
          body: update.body ?? undefined,
        },
      });

      return;
    }

    pendingUpdate = null;
    patchState(queryClient, {
      status: "up-to-date",
      error: null,
      updateInfo: null,
    });
  } catch (error) {
    console.error("[Updater] Check failed:", error);
    patchState(queryClient, {
      status: "error",
      error: genericErrorMessage(),
    });
  }
}

export async function downloadAndInstall(queryClient: QueryClient) {
  if (!isTauri() || !pendingUpdate) {
    patchState(queryClient, {
      status: "error",
      error: genericErrorMessage(),
    });
    throw new Error(genericErrorMessage());
  }

  patchState(queryClient, {
    status: "downloading",
    error: null,
    progress: {
      downloaded: 0,
      total: null,
    },
  });

  try {
    await pendingUpdate.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          patchState(queryClient, {
            progress: {
              downloaded: 0,
              total: event.data.contentLength ?? null,
            },
          });
          break;
        case "Progress":
          patchState(queryClient, (state) => ({
            progress: {
              ...state.progress,
              downloaded:
                state.progress.downloaded + (event.data.chunkLength ?? 0),
            },
          }));
          break;
        case "Finished":
          break;
      }
    });

    patchState(queryClient, {
      status: "ready",
      error: null,
    });
  } catch (error) {
    console.error("[Updater] Download failed:", error);
    patchState(queryClient, {
      status: "error",
      error: genericErrorMessage(),
    });
    throw new Error(genericErrorMessage());
  }
}

export async function relaunchApp(queryClient: QueryClient) {
  if (!isTauri()) {
    return;
  }

  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (error) {
    console.error("[Updater] Relaunch failed:", error);
    patchState(queryClient, {
      status: "error",
      error: genericErrorMessage(),
    });
  }
}

export function startDownloadWithToastPromise(queryClient: QueryClient) {
  const downloadPromise = downloadAndInstall(queryClient);

  toast.promise(downloadPromise, {
    loading: i18n.t("updaterToastDownloading"),
    success: i18n.t("updaterToastDownloaded"),
    error: i18n.t("updaterGenericError"),
  });

  void downloadPromise.then(() => {
    toast.success(i18n.t("updaterToastReadyToRestart"), {
      action: {
        label: i18n.t("updaterRestart"),
        onClick: () => {
          void relaunchApp(queryClient);
        },
      },
    });
  });
}

export function AppUpdaterBootstrap() {
  const queryClient = useQueryClient();
  const { data: updater } = useQuery(getAppUpdaterQueryOptions(queryClient));
  const didRunInitialCheckRef = useRef(false);
  const lastNotifiedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    if (didRunInitialCheckRef.current) {
      return;
    }

    didRunInitialCheckRef.current = true;
    void checkForUpdate(queryClient);
  }, [queryClient]);

  useEffect(() => {
    if (updater.status !== "available" || !updater.updateInfo) {
      return;
    }

    if (lastNotifiedVersionRef.current === updater.updateInfo.version) {
      return;
    }

    lastNotifiedVersionRef.current = updater.updateInfo.version;

    toast(
      i18n.t("updaterToastAvailableTitle", {
        version: updater.updateInfo.version,
      }),
      {
        description: i18n.t("updaterToastAvailableDescription"),
        action: {
          label: i18n.t("updaterDownload"),
          onClick: () => {
            startDownloadWithToastPromise(queryClient);
          },
        },
      },
    );
  }, [queryClient, updater.status, updater.updateInfo]);

  return null;
}
