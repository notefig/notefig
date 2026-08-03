import "./App.css";
import { Routes, Route, Navigate, useNavigate, useLocation } from "react-router-dom";
import { Workspace } from "@/components/workspace";
import { Welcome } from "@/components/welcome";
import { RootRedirect } from "@/components/root-redirect";
import { MockDirectoryPickerDialog } from "@/components/mock-directory-picker-dialog";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { useCallback, useEffect } from "react";
import { useTheme } from "@/components/theme-provider";
import { platformAdapter } from "@/adapters";
import { isWeb } from "@/utils/platform";
import { Loader } from "./components/loader";
import { Titlebar } from "@/components/titlebar";
import { useAppSettings } from "@/hooks/use-app-settings";
import { WorkspaceErrorBoundary } from "@/components/workspace-error-boundary";
import { EditorHarness } from "@/test-harness/editor-harness";
import { ensureStartupHarnessDiscovery } from "@/agent/harness-discovery";
import { PairDialog } from "@/components/tunnel/pair-dialog";
import {
  autoConnectStoredPairing,
  watchCrossTabPairing,
} from "@/agent/tunnel/connect-flow";
import { hadDeepLinkPairing } from "@/agent/tunnel/pair-dialog-store";
import { LAYOUT_PARAM, parseLayout } from "@/utils/layout-codec";
import { openFileInLayout } from "@/utils/dockable-layout";
import { buildLooseFileUrl } from "@/utils/loose-workspace";
import { captureEvent } from "@/telemetry/telemetry";

export const App = () => {
  const { setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const {
    settings,
    setTheme: persistTheme,
    setLastPath,
    setZoomLevel,
  } = useAppSettings();

  useEffect(() => {
    setTheme(settings.theme);
  }, [settings.theme, setTheme]);

  // One harness-discovery scan per app session (self-guarded; StrictMode's
  // double-invoke and remounts are no-ops).
  useEffect(() => {
    ensureStartupHarnessDiscovery();
  }, []);

  // Web only: reconnect to a previously paired worker on boot. Non-fatal —
  // a stale pairing (worker restarted → new URL) just leaves the tunnel
  // disconnected and the status pill offers a re-pair. Also listen for a
  // pairing done in another tab (the CLI-opened tab) and connect this one.
  //
  // Skip the stored reconnect when this load carried a deep-link code: the
  // CLI-opened `/pair#<code>` tab has a FRESH code the dialog is about to
  // connect, and the stored pairing points at the previous (now-dead) port —
  // racing it would clobber the fresh connect with "could not reach the worker".
  useEffect(() => {
    if (!isWeb()) return;
    if (!hadDeepLinkPairing) void autoConnectStoredPairing();
    return watchCrossTabPairing();
  }, []);

  useEffect(() => {
    // "/pair" is a transient deep-link landing that redirects to "/" — never
    // record it, or RootRedirect would bounce back to it in a loop.
    if (
      location.pathname !== "/" &&
      location.pathname !== "/welcome" &&
      location.pathname !== "/pair"
    ) {
      const fullPath = location.pathname + location.search;
      setLastPath(fullPath);
    }
  }, [location.pathname, location.search, setLastPath]);

  // A file arriving from outside the app (Open File menu, OS "open with"):
  // merge it into the current workspace's layout as a loose tab — the
  // tab-derived registration (useLooseFileRegistration) picks it up from
  // the URL — or, with no workspace open, edit it in the loose sentinel
  // workspace. Reads the URL fresh: event listeners would otherwise close
  // over a stale location.
  const openExternalFile = useCallback(
    (filePath: string) => {
      const pathname = window.location.pathname;
      const isWorkspaceRoute =
        pathname !== "/" &&
        pathname !== "/welcome" &&
        pathname !== "/pair" &&
        !pathname.startsWith("/__harness");
      // Canary for OS "open with" delivery: cold-start emits (app launched
      // BY opening a file) have unverified delivery and no buffering — if
      // association usage in the wild shows only with_workspace opens,
      // that's the signal the cold-start path needs solving.
      captureEvent("external_file_opened", {
        with_workspace: isWorkspaceRoute,
      });
      if (!isWorkspaceRoute) {
        navigate(buildLooseFileUrl(filePath));
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const layout = parseLayout(params.get(LAYOUT_PARAM));
      const nextLayout = openFileInLayout(layout, {
        tabId: filePath,
        intent: "new-tab",
      });
      params.set(LAYOUT_PARAM, JSON.stringify(nextLayout));
      navigate(`${pathname}?${params.toString()}`);
    },
    [navigate],
  );

  useEffect(() => {
    const cleanup = platformAdapter.addEventListener((event) => {
      switch (event.type) {
        case "theme-changed":
          setTheme(event.payload);
          persistTheme(event.payload);
          break;
        case "folder-selected": {
          const encodedPath = encodeURIComponent(event.payload);
          navigate(`/${encodedPath}`);
          break;
        }
        case "file-selected":
          openExternalFile(event.payload);
          break;
        case "file-dropped":
          console.log({ app: event.payload });
          break;
        case "zoom-changed":
          setZoomLevel(event.payload);
          break;
      }
    });

    return cleanup;
  }, [setTheme, persistTheme, navigate, setZoomLevel, openExternalFile]);

  return (
    <div className="flex h-screen flex-col text-foreground overflow-hidden">
      <Titlebar />
      {isWeb() && <MockDirectoryPickerDialog />}
      <TextPromptDialog />
      <PairDialog />
      <div className="flex-1 min-h-0">
        <Routes>
          {import.meta.env.DEV && (
            <Route path="/__harness/editor" element={<EditorHarness />} />
          )}
          <Route
            path="/:basePath/edit/*"
            element={
              <Loader>
                <WorkspaceErrorBoundary>
                  <Workspace />
                </WorkspaceErrorBoundary>
              </Loader>
            }
          />
          <Route
            path="/:basePath"
            element={
              <Loader>
                <WorkspaceErrorBoundary>
                  <Workspace />
                </WorkspaceErrorBoundary>
              </Loader>
            }
          />
          <Route
            path="/welcome"
            element={
              <WorkspaceErrorBoundary>
                <Welcome />
              </WorkspaceErrorBoundary>
            }
          />
          {/* Deep-link landing: the pairing code was captured + scrubbed
              from the fragment at module load (pair-dialog-store), which
              also opened the dialog — this just returns to the app. */}
          <Route path="/pair" element={<Navigate to="/" replace />} />
          <Route
            path="/"
            element={
              <WorkspaceErrorBoundary>
                <RootRedirect />
              </WorkspaceErrorBoundary>
            }
          />
        </Routes>
      </div>
    </div>
  );
};
