import "./App.css";
import { Routes, Route, useNavigate } from "react-router-dom";
import { Workspace } from "@/components/workspace";
import { Welcome } from "@/components/welcome";
import { MockDirectoryPickerDialog } from "@/components/mock-directory-picker-dialog";
import { useEffect } from "react";
import { useTheme } from "@/components/theme-provider";
import { platformAdapter } from "@/adapters";
import { isWeb } from "@/utils/platform";
import { Loader } from "./components/loader";
import { Titlebar } from "@/components/titlebar";
import { useAppSettings } from "@/hooks/use-app-settings";

export const App = () => {
  const { setTheme } = useTheme();
  const navigate = useNavigate();
  const {
    settings,
    setTheme: persistTheme,
    setLastWorkspace,
  } = useAppSettings();

  useEffect(() => {
    setTheme(settings.theme);
  }, [settings.theme, setTheme]);

  useEffect(() => {
    if (settings.lastWorkspace) {
      const encodedPath = encodeURIComponent(settings.lastWorkspace);
      navigate(`/${encodedPath}`);
    }
  }, [settings.lastWorkspace]);

  useEffect(() => {
    const cleanup = platformAdapter.addEventListener((event) => {
      switch (event.type) {
        case "theme-changed":
          setTheme(event.payload);
          persistTheme(event.payload);
          break;
        case "folder-selected": {
          const encodedPath = encodeURIComponent(event.payload);
          setLastWorkspace(event.payload);
          navigate(`/${encodedPath}`);
          break;
        }
        case "file-dropped":
          console.log({ app: event.payload });
          break;
      }
    });

    return cleanup;
  }, [setTheme, persistTheme, setLastWorkspace, navigate]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      <Titlebar />
      {/* Only render mock directory picker in browser/web mode */}
      {isWeb() && <MockDirectoryPickerDialog />}
      <div className="flex-1 min-h-0">
        <Routes>
          {/* Edit route - file selected for editing (most specific first) */}
          <Route
            path="/:basePath/edit/*"
            element={
              <Loader>
                <Workspace />
              </Loader>
            }
          />
          {/* Base path route - no file selected */}
          <Route
            path="/:basePath"
            element={
              <Loader>
                <Workspace />
              </Loader>
            }
          />
          {/* Root route - no directory selected */}
          <Route path="/" element={<Welcome />} />
        </Routes>
      </div>
    </div>
  );
};
