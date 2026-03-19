import "./App.css";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { Workspace } from "@/components/workspace";
import { Welcome } from "@/components/welcome";
import { RootRedirect } from "@/components/root-redirect";
import { MockDirectoryPickerDialog } from "@/components/mock-directory-picker-dialog";
import { useEffect } from "react";
import { useTheme } from "@/components/theme-provider";
import { platformAdapter } from "@/adapters";
import { isWeb } from "@/utils/platform";
import { Loader } from "./components/loader";
import { Titlebar } from "@/components/titlebar";
import { useAppSettings } from "@/hooks/use-app-settings";
import { WorkspaceErrorBoundary } from "@/components/workspace-error-boundary";

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

  useEffect(() => {
    if (location.pathname !== "/" && location.pathname !== "/welcome") {
      const fullPath = location.pathname + location.search;
      setLastPath(fullPath);
    }
  }, [location.pathname, location.search, setLastPath]);

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
    <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      <Titlebar />
      {isWeb() && <MockDirectoryPickerDialog />}
      <div className="flex-1 min-h-0">
        <Routes>
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
