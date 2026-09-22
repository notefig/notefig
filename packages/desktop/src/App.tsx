import "./App.css";
import {
  Routes,
  Route,
  Navigate,
  useNavigate,
  useLocation,
} from "react-router-dom";
import { Workspace } from "@/components/workspace";
import { MockDirectoryPickerDialog } from "@/components/mock-directory-picker-dialog";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { useEffect, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { platformAdapter } from "@/adapters";
import { isWeb } from "@/utils/platform";
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
    isReady: settingsReady,
    setTheme: persistTheme,
    setLastSearch,
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

  // The URL carries the session (layout, chrome); the pathname is always
  // "/". Restore last session's search once settings have hydrated — a
  // cold boot lands on a bare "/" — then keep recording it. The restore is
  // a render phase, not a ref: the record effect must not run in the same
  // commit as the restore, or it would persist the bare boot URL over the
  // saved one before the navigation lands. Flipping state defers it by
  // exactly one render, which is also the render the navigation reaches.
  const [sessionRestored, setSessionRestored] = useState(false);
  useEffect(() => {
    if (!settingsReady || sessionRestored) return;
    if (
      location.pathname === "/" &&
      !location.search &&
      settings.lastSearch
    ) {
      navigate(`/${settings.lastSearch}`, { replace: true });
    }
    setSessionRestored(true);
  }, [settingsReady, sessionRestored, settings.lastSearch, location, navigate]);
  useEffect(() => {
    if (!sessionRestored || location.pathname !== "/") return;
    // One encoding of "nothing": an empty search is stored as null, the
    // declared default, never as "".
    setLastSearch(location.search || null);
  }, [sessionRestored, location.pathname, location.search, setLastSearch]);

  useEffect(() => {
    const cleanup = platformAdapter.ui.addEventListener((event) => {
      switch (event.type) {
        case "theme-changed":
          setTheme(event.payload);
          persistTheme(event.payload);
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
  }, [setTheme, persistTheme, setZoomLevel]);

  return (
    <div className="flex h-screen flex-col text-foreground overflow-clip">
      {isWeb() && <MockDirectoryPickerDialog />}
      <TextPromptDialog />
      <PairDialog />
      <div className="flex-1 min-h-0">
        <Routes>
          {import.meta.env.DEV && (
            <Route path="/__harness/editor" element={<EditorHarness />} />
          )}
          {/* Deep-link landing: the pairing code was captured + scrubbed
              from the fragment at module load (pair-dialog-store), which
              also opened the dialog — this just returns to the app. */}
          <Route path="/pair" element={<Navigate to="/" replace />} />
          {/* The whole app lives at "/": the dock is one layout over every
              open workspace, and the welcome screen is what "/" shows with
              nothing open. Any other path is a stale bookmark. */}
          <Route
            path="/"
            element={
              <WorkspaceErrorBoundary>
                <Workspace />
              </WorkspaceErrorBoundary>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
};
