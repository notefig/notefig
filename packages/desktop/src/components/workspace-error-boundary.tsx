import { Component, useEffect, useSyncExternalStore } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { FolderLock } from "lucide-react";
import { toast } from "sonner";
import { DebugPanel } from "./debug-panel";
import { Button } from "@notefig/ui/button";
import { platformAdapter } from "@/adapters";
import {
  FsError,
  isWorkspaceAccessError,
} from "@/adapters/platform-adapter.interface";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";
import { clearWorkspaceCollections } from "@/entities/files";
import { queryClient } from "@/entities/query-client";
import { isWeb } from "@/utils/platform";
import { captureError } from "@/telemetry/telemetry";

interface WorkspaceErrorBoundaryProps {
  children: ReactNode;
}

interface WorkspaceErrorBoundaryState {
  error: Error | null;
}

export class WorkspaceErrorBoundary extends Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  constructor(props: WorkspaceErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): WorkspaceErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[WorkspaceErrorBoundary] Caught error:", error);
    if (errorInfo.componentStack) {
      console.error(
        "[WorkspaceErrorBoundary] Component stack:",
        errorInfo.componentStack,
      );
    }
    // Workspace-access errors are expected (fs permission loss) and get
    // their own recovery UI — never reported as crashes.
    if (!isWorkspaceAccessError(error)) {
      captureError(error, { boundary: "workspace" });
    }
  }

  render() {
    const { error } = this.state;
    if (error) {
      if (isWorkspaceAccessError(error)) {
        return (
          <WorkspaceAccessError
            error={error}
            onResolved={() => this.setState({ error: null })}
          />
        );
      }
      return (
        <DebugPanel
          forceOpen
          error={{ message: error.message, stack: error.stack }}
        />
      );
    }

    return this.props.children;
  }
}

/**
 * Surface workspace access failures from the fs-backed query layer as a
 * render-time throw, so WorkspaceErrorBoundary can catch them. The data
 * layer holds query errors internally and would otherwise just render an
 * empty workspace.
 */
export function useThrowWorkspaceAccessError(workspaceId: string) {
  const error = useSyncExternalStore(
    subscribeToQueryCache,
    () => queryClient.getQueryState(["file-metadata", workspaceId])?.error,
  );
  if (isWorkspaceAccessError(error)) throw error;
}

function subscribeToQueryCache(onStoreChange: () => void) {
  return queryClient.getQueryCache().subscribe(onStoreChange);
}

const MACOS_FILES_AND_FOLDERS_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesFolders";
const CHROME_SITE_PERMISSIONS_HELP_URL =
  "https://support.google.com/chrome/answer/114662";

const isMacDesktop = () =>
  !isWeb() && navigator.platform.toLowerCase().includes("mac");

type RecoveryContent = {
  title: string;
  body: string;
  actionLabel: string;
  showSystemSettings: boolean;
  showSitePermissionsHelp: boolean;
};

function getRecoveryContent(
  error: FsError,
  t: (key: string) => string,
): RecoveryContent {
  if (error.type === "handle_missing") {
    return {
      title: t("fsReconnectTitle"),
      body: t("fsReconnectBody"),
      actionLabel: t("fsChooseFolderAgain"),
      showSystemSettings: false,
      showSitePermissionsHelp: false,
    };
  }
  if (isWeb()) {
    return {
      title: t("fsAccessLostTitle"),
      body: t("fsAccessLostBodyWeb"),
      actionLabel: t("fsRestoreAccess"),
      showSystemSettings: false,
      showSitePermissionsHelp: true,
    };
  }
  return {
    title: t("fsAccessLostTitle"),
    body: t("fsAccessLostBodyDesktop"),
    actionLabel: t("retry"),
    showSystemSettings: isMacDesktop(),
    showSitePermissionsHelp: false,
  };
}

/**
 * Fallback for fs permission failures: explains what happened and offers
 * the right re-grant action per platform. Resolving clears the workspace's
 * cached collections and resets the boundary so everything refetches.
 */
function WorkspaceAccessError({
  error,
  onResolved,
}: {
  error: FsError;
  onResolved: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { workspacePath } = useWorkspaceParams();
  const content = getRecoveryContent(error, t);

  useEffect(() => {
    toast.error(content.title);
  }, [content.title]);

  const resume = (path: string) => {
    clearWorkspaceCollections(path);
    onResolved();
  };

  const handleRepick = async () => {
    const picked = await platformAdapter.ui
      .pickDirectory(t("pickDirectory"))
      .catch(() => null);
    if (!picked) return;
    if (picked !== workspacePath) {
      navigate(`/${encodeURIComponent(picked)}`);
    }
    resume(picked);
  };

  const handleRestore = async () => {
    const target = workspacePath ?? error.path;
    // Web: must call requestPermission inside this click. Desktop: no-op
    // true — the retry refetch will surface the error again if still denied.
    const granted = await platformAdapter.fs.requestWorkspaceAccess(target);
    if (!granted) {
      toast.error(t("fsAccessLostBodyWeb"));
      return;
    }
    resume(target);
  };

  const handleRecover =
    error.type === "handle_missing" ? handleRepick : handleRestore;

  return (
    <div className="flex h-full flex-col items-center justify-center bg-background px-6 texture-surface">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-md bg-muted">
          <FolderLock className="h-6 w-6 text-primary" />
        </div>
        <h2 className="text-lg font-medium text-foreground">
          {content.title}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{content.body}</p>
        <div className="mt-6 flex flex-col gap-2">
          <Button onClick={handleRecover}>{content.actionLabel}</Button>
          {content.showSystemSettings && (
            <Button
              variant="secondary"
              onClick={() =>
                platformAdapter.ui.openExternal(
                  MACOS_FILES_AND_FOLDERS_SETTINGS_URL,
                )
              }
            >
              {t("fsOpenSystemSettings")}
            </Button>
          )}
          <Button variant="ghost" onClick={() => navigate("/welcome")}>
            {t("backToHome")}
          </Button>
          {content.showSitePermissionsHelp && (
            <button
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() =>
                platformAdapter.ui.openExternal(CHROME_SITE_PERMISSIONS_HELP_URL)
              }
            >
              {t("fsSitePermissionsHelp")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
