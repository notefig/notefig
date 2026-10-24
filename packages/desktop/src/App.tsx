import "./App.css";
import { Routes, Route, Navigate } from "react-router-dom";
import { Workspace } from "@/components/workspace";
import { MockDirectoryPickerDialog } from "@/components/mock-directory-picker-dialog";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { FeedbackDialog } from "@/modules/feedback/react";
import { useEffect } from "react";
import { useTheme } from "@/components/theme-provider";
import { isWeb } from "@/utils/platform";
import { useAppSettings } from "@/hooks/use-app-settings";
import { WorkspaceErrorBoundary } from "@/components/workspace-error-boundary";
import { EditorHarness } from "@/test-harness/editor-harness";
import { PairDialog } from "@/components/tunnel/pair-dialog";
import { useCore } from "@notefig/core/react";

export const App = () => {
  const { setTheme } = useTheme();
  const { settings, setTheme: persistTheme, setZoomLevel } = useAppSettings();

  useEffect(() => {
    setTheme(settings.theme);
  }, [settings.theme, setTheme]);

  const { ui } = useCore().platform;
  useEffect(() => {
    const cleanup = ui.addEventListener((event) => {
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
  }, [ui, setTheme, persistTheme, setZoomLevel]);

  return (
    <div className="flex h-screen flex-col text-foreground overflow-clip">
      {isWeb() && <MockDirectoryPickerDialog />}
      <TextPromptDialog />
      <FeedbackDialog />
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
