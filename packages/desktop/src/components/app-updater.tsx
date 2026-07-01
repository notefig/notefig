import { useEffect, useRef } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { platformAdapter } from "@/adapters";
import i18n from "@/utils/intl";
import { isTauri } from "@/utils/platform";
import type { UpdateFlow } from "@/adapters/platform-adapter.interface";

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
  flow: UpdateFlow;
}

export const APP_UPDATER_QUERY_KEY = ["app-updater"] as const;

const INITIAL_UPDATER_STATE: AppUpdaterState = {
  status: "idle",
  progress: {
    downloaded: 0,
    total: null,
  },
  error: null,
  updateInfo: null,
  flow: "download-restart",
};

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
  patchState(queryClient, {
    status: "checking",
    error: null,
  });

  const result = await platformAdapter.getUpdater().check();

  if (result.status === "error") {
    patchState(queryClient, {
      status: "error",
      error: genericErrorMessage(),
    });
    return;
  }

  if (result.status === "available") {
    patchState(queryClient, {
      status: "available",
      error: null,
      flow: result.flow,
      updateInfo: {
        version: result.version,
        body: result.body,
      },
    });
    return;
  }

  patchState(queryClient, {
    status: "up-to-date",
    error: null,
    flow: result.flow,
    updateInfo: null,
  });
}

export async function downloadAndInstall(queryClient: QueryClient) {
  patchState(queryClient, {
    status: "downloading",
    error: null,
    progress: {
      downloaded: 0,
      total: null,
    },
  });

  const updater = platformAdapter.getUpdater();

  for await (const step of updater.apply()) {
    if (step.status === "downloading") {
      patchState(queryClient, {
        status: "downloading",
        error: null,
        progress: {
          downloaded: step.downloaded,
          total: step.total,
        },
      });
      continue;
    }

    if (step.status === "ready" || step.status === "applied") {
      patchState(queryClient, {
        status: "ready",
        error: null,
      });
      continue;
    }

    patchState(queryClient, {
      status: "error",
      error: genericErrorMessage(),
    });
    throw new Error(genericErrorMessage());
  }
}

export async function relaunchApp(queryClient: QueryClient) {
  const result = await platformAdapter.getUpdater().restart();
  if (result.status === "error") {
    patchState(queryClient, {
      status: "error",
      error: genericErrorMessage(),
    });
  }
}

export function startDownloadWithToastPromise(queryClient: QueryClient) {
  const state = getStoredState(queryClient);

  if (state.flow === "refresh") {
    void relaunchApp(queryClient);
    return;
  }

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

    if (!isTauri()) {
      return;
    }

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
        description:
          updater.flow === "refresh"
            ? i18n.t("updaterToastAvailableDescriptionRefresh")
            : i18n.t("updaterToastAvailableDescription"),
        action: {
          label:
            updater.flow === "refresh"
              ? i18n.t("updaterRefresh")
              : i18n.t("updaterDownload"),
          onClick: () => {
            startDownloadWithToastPromise(queryClient);
          },
        },
      },
    );
  }, [queryClient, updater.status, updater.updateInfo]);

  return null;
}
