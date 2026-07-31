import { useEffect, useRef } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { platformAdapter } from "@/adapters";
import { useAppSettings } from "@/hooks/use-app-settings";
import i18n from "@/utils/intl";
import { isTauri } from "@/utils/platform";
import { captureEvent } from "@/telemetry/telemetry";
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

/** How often to re-check for updates while the app is running. */
const UPDATE_CHECK_INTERVAL_MS = 15 * 60 * 1000;
/** Focus-triggered refetches are skipped while the result is fresher than this. */
const UPDATE_CHECK_STALE_TIME_MS = 10 * 60 * 1000;

function genericErrorMessage(): string {
  return i18n.t("updaterGenericError");
}

/**
 * Update toasts stay until the user acts on them: they carry an action the
 * user may not be ready for yet, and a timed dismissal silently loses it.
 * The close button is what makes them dismissible.
 */
const PERSISTENT_TOAST_OPTIONS = {
  duration: Number.POSITIVE_INFINITY,
  closeButton: true,
} as const;

// Update check — a real query. TanStack Query provides the proactive
// behavior: fetch on mount, refetch on window focus (throttled by
// staleTime), refetch on an interval, and dedupe of concurrent checks.

export const UPDATE_CHECK_QUERY_KEY = ["app-update-check"] as const;

export interface UpdateCheckData {
  flow: UpdateFlow;
  updateInfo: UpdateInfo | null;
}

async function fetchUpdateCheck(): Promise<UpdateCheckData> {
  const result = await platformAdapter.getUpdater().check();

  if (result.status === "error") {
    throw new Error(result.error);
  }

  if (result.status === "available") {
    return {
      flow: result.flow,
      updateInfo: {
        version: result.version,
        body: result.body,
      },
    };
  }

  return {
    flow: result.flow,
    updateInfo: null,
  };
}

export function getUpdateCheckQueryOptions(queryClient: QueryClient) {
  return {
    queryKey: UPDATE_CHECK_QUERY_KEY,
    queryFn: fetchUpdateCheck,
    // Automatic checks are Tauri-only: browser builds run the dev server /
    // e2e suite too, where version drift would nag constantly. The manual
    // settings button still works there — refetch() ignores `enabled`.
    enabled: isTauri(),
    retry: false,
    staleTime: UPDATE_CHECK_STALE_TIME_MS,
    gcTime: Number.POSITIVE_INFINITY,
    // Pause automatic checks while an install is underway so a check can't
    // race a download or replace a staged update's info.
    refetchInterval: () =>
      isInstallActive(queryClient) ? false : UPDATE_CHECK_INTERVAL_MS,
    refetchOnWindowFocus: () => !isInstallActive(queryClient),
  };
}

// Install state — download/restart progress. This is mutation-style state
// shared across components (settings modal, toasts), so it lives in the
// query cache as a passive entry that the install functions patch.

export const UPDATE_INSTALL_QUERY_KEY = ["app-update-install"] as const;

export type InstallPhase = "idle" | "downloading" | "ready" | "error";

export interface InstallState {
  phase: InstallPhase;
  progress: UpdateProgress;
  error: string | null;
}

const INITIAL_INSTALL_STATE: InstallState = {
  phase: "idle",
  progress: {
    downloaded: 0,
    total: null,
  },
  error: null,
};

function getInstallState(queryClient: QueryClient): InstallState {
  return (
    queryClient.getQueryData<InstallState>(UPDATE_INSTALL_QUERY_KEY) ??
    INITIAL_INSTALL_STATE
  );
}

function patchInstallState(
  queryClient: QueryClient,
  patch: Partial<InstallState>,
) {
  queryClient.setQueryData<InstallState>(UPDATE_INSTALL_QUERY_KEY, (prev) => ({
    ...(prev ?? INITIAL_INSTALL_STATE),
    ...patch,
  }));
}

function getInstallStateQueryOptions(queryClient: QueryClient) {
  return {
    queryKey: UPDATE_INSTALL_QUERY_KEY,
    queryFn: async () => getInstallState(queryClient),
    initialData: INITIAL_INSTALL_STATE,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  };
}

function isInstallActive(queryClient: QueryClient): boolean {
  const phase = getInstallState(queryClient).phase;
  return phase === "downloading" || phase === "ready";
}

export interface AppUpdaterView {
  status: UpdaterStatus;
  progress: UpdateProgress;
  error: string | null;
  updateInfo: UpdateInfo | null;
  flow: UpdateFlow;
}

/**
 * Collapse check-query state and install state into the single status the
 * UI renders. Install phases win: once a download starts, check activity
 * must not flip the UI back to "checking".
 */
export function deriveUpdaterView(
  check: {
    data: UpdateCheckData | undefined;
    isFetching: boolean;
    isError: boolean;
  },
  install: InstallState,
): AppUpdaterView {
  const updateInfo = check.data?.updateInfo ?? null;
  const flow = check.data?.flow ?? "download-restart";

  if (install.phase === "downloading") {
    return {
      status: "downloading",
      progress: install.progress,
      error: null,
      updateInfo,
      flow,
    };
  }

  if (install.phase === "ready") {
    return {
      status: "ready",
      progress: install.progress,
      error: null,
      updateInfo,
      flow,
    };
  }

  if (install.phase === "error") {
    return {
      status: "error",
      progress: install.progress,
      error: install.error ?? genericErrorMessage(),
      updateInfo,
      flow,
    };
  }

  let status: UpdaterStatus;
  if (check.isFetching) {
    status = "checking";
  } else if (check.isError) {
    status = "error";
  } else if (updateInfo) {
    status = "available";
  } else if (check.data) {
    status = "up-to-date";
  } else {
    status = "idle";
  }

  return {
    status,
    progress: install.progress,
    error: status === "error" ? genericErrorMessage() : null,
    updateInfo,
    flow,
  };
}

export function useAppUpdater(): AppUpdaterView & {
  checkForUpdate: () => void;
} {
  const queryClient = useQueryClient();
  const check = useQuery(getUpdateCheckQueryOptions(queryClient));
  const { data: install } = useQuery(getInstallStateQueryOptions(queryClient));

  return {
    ...deriveUpdaterView(check, install),
    checkForUpdate: () => {
      void check.refetch();
    },
  };
}

/** The version an in-flight install is heading to, for telemetry. */
function pendingUpdateVersion(queryClient: QueryClient): string {
  return (
    queryClient.getQueryData<UpdateCheckData>(UPDATE_CHECK_QUERY_KEY)
      ?.updateInfo?.version ?? "unknown"
  );
}

export type DownloadTrigger = "auto" | "manual";

export async function downloadAndInstall(
  queryClient: QueryClient,
  trigger: DownloadTrigger = "manual",
) {
  const toVersion = pendingUpdateVersion(queryClient);
  let downloadCompleted = false;
  captureEvent("update_download_started", { to_version: toVersion, trigger });
  patchInstallState(queryClient, {
    phase: "downloading",
    error: null,
    progress: {
      downloaded: 0,
      total: null,
    },
  });

  const updater = platformAdapter.getUpdater();

  for await (const step of updater.apply()) {
    if (step.status === "downloading") {
      patchInstallState(queryClient, {
        phase: "downloading",
        error: null,
        progress: {
          downloaded: step.downloaded,
          total: step.total,
        },
      });
      continue;
    }

    if (step.status === "ready" || step.status === "applied") {
      if (!downloadCompleted) {
        downloadCompleted = true;
        captureEvent("update_download_completed", { to_version: toVersion });
      }
      patchInstallState(queryClient, {
        phase: "ready",
        error: null,
      });
      continue;
    }

    captureEvent("update_failed", { stage: "download", to_version: toVersion });
    patchInstallState(queryClient, {
      phase: "error",
      error: genericErrorMessage(),
    });
    throw new Error(genericErrorMessage());
  }
}

export async function relaunchApp(queryClient: QueryClient) {
  const result = await platformAdapter.getUpdater().restart();
  if (result.status === "error") {
    captureEvent("update_failed", {
      stage: "restart",
      to_version: pendingUpdateVersion(queryClient),
    });
    patchInstallState(queryClient, {
      phase: "error",
      error: genericErrorMessage(),
    });
  }
}

export function startDownloadWithToastPromise(queryClient: QueryClient) {
  const checkData = queryClient.getQueryData<UpdateCheckData>(
    UPDATE_CHECK_QUERY_KEY,
  );

  if (checkData?.flow === "refresh") {
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
    showReadyToRestartToast(queryClient);
  });
}

function showReadyToRestartToast(queryClient: QueryClient) {
  toast.success(i18n.t("updaterToastReadyToRestart"), {
    ...PERSISTENT_TOAST_OPTIONS,
    action: {
      label: i18n.t("updaterRestart"),
      onClick: () => {
        void relaunchApp(queryClient);
      },
    },
  });
}

function showUpdateAvailableToast(
  queryClient: QueryClient,
  flow: UpdateFlow,
  updateInfo: UpdateInfo,
) {
  toast(
    i18n.t("updaterToastAvailableTitle", {
      version: updateInfo.version,
    }),
    {
      ...PERSISTENT_TOAST_OPTIONS,
      description:
        flow === "refresh"
          ? i18n.t("updaterToastAvailableDescriptionRefresh")
          : i18n.t("updaterToastAvailableDescription"),
      action: {
        label:
          flow === "refresh"
            ? i18n.t("updaterRefresh")
            : i18n.t("updaterDownload"),
        onClick: () => {
          startDownloadWithToastPromise(queryClient);
        },
      },
    },
  );
}

// Bootstrap — subscribes to the check query (which starts the automatic
// mount/focus/interval checks) and reacts to an available update: silent
// auto-download when the setting allows it, a prompt toast otherwise.

export type UpdateNotificationAction = "auto-download" | "prompt" | "none";

/**
 * Decide how to react to a newly discovered update. "none" defers: settings
 * not yet loaded (acting on the optimistic default could override an
 * opt-out) or an install already in flight. The refresh flow never
 * auto-applies — it relaunches the app, which must stay a user action.
 */
export function resolveUpdateNotification(input: {
  autoUpdateEnabled: boolean;
  settingsReady: boolean;
  flow: UpdateFlow;
  installActive: boolean;
}): UpdateNotificationAction {
  if (!input.settingsReady || input.installActive) {
    return "none";
  }
  if (input.autoUpdateEnabled && input.flow === "download-restart") {
    return "auto-download";
  }
  return "prompt";
}

export function AppUpdaterBootstrap() {
  const queryClient = useQueryClient();
  const { data } = useQuery(getUpdateCheckQueryOptions(queryClient));
  const { settings, isReady } = useAppSettings();
  const lastNotifiedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    const updateInfo = data?.updateInfo;
    if (!updateInfo) {
      return;
    }

    if (lastNotifiedVersionRef.current === updateInfo.version) {
      return;
    }

    const action = resolveUpdateNotification({
      autoUpdateEnabled: settings.autoUpdateEnabled,
      settingsReady: isReady,
      flow: data.flow,
      installActive: isInstallActive(queryClient),
    });
    if (action === "none") {
      return;
    }

    lastNotifiedVersionRef.current = updateInfo.version;
    captureEvent("update_available", { to_version: updateInfo.version });

    if (action === "auto-download") {
      // Silent download; the user only hears about it once it's ready. On
      // failure fall back to the prompt toast so a manual retry is possible.
      downloadAndInstall(queryClient, "auto")
        .then(() => {
          showReadyToRestartToast(queryClient);
        })
        .catch(() => {
          showUpdateAvailableToast(queryClient, data.flow, updateInfo);
        });
      return;
    }

    showUpdateAvailableToast(queryClient, data.flow, updateInfo);
  }, [queryClient, data, settings.autoUpdateEnabled, isReady]);

  return null;
}
