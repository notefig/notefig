import "./App.css";
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { Workspace } from "@/components/workspace";
import { Welcome } from "@/components/welcome";
import { RootRedirect } from "@/components/root-redirect";
import { MockDirectoryPickerDialog } from "@/components/mock-directory-picker-dialog";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { useEffect } from "react";
import { useTheme } from "@/components/theme-provider";
import { platformAdapter } from "@/adapters";
import { isWeb } from "@/utils/platform";
import { Loader } from "./components/loader";
import { Titlebar } from "@/components/titlebar";
import { useAppSettings } from "@/hooks/use-app-settings";
import { WorkspaceErrorBoundary } from "@/components/workspace-error-boundary";
import { EditorHarness } from "@/test-harness/editor-harness";
import { ensureStartupHarnessDiscovery } from "@/agent/harness-discovery";
import { ensureAgentTasksReconciled } from "@/agent/agent-collections";
import { PairDialog } from "@/components/tunnel/pair-dialog";
import {
  autoConnectStoredPairing,
  watchCrossTabPairing,
} from "@/agent/tunnel/connect-flow";
import { hadDeepLinkPairing } from "@/agent/tunnel/pair-dialog-store";

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

  // Bring persisted agent tasks in line with this session: rows without a live
  // runtime demote to "restored", rows with no session at all are dropped.
  // Same self-guarded, fire-and-forget shape as the scan above.
  useEffect(() => {
    ensureAgentTasksReconciled();
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

  useEffect(() => {
    const cleanup = platformAdapter.ui.addEventListener((event) => {
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
        case "file-dropped":
          console.log({ app: event.payload });
          break;
        case "zoom-changed":
          setZoomLevel(event.payload);
          break;
      }
    });

    return cleanup;
  }, [setTheme, persistTheme, navigate, setZoomLevel]);

  return (
    <div className="flex h-screen flex-col text-foreground overflow-clip">
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
