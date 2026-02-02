import "./App.css";
import { Routes, Route } from "react-router-dom";
import { Workspace } from "@/components/workspace";
import { Welcome } from "@/components/welcome";
import { MockDirectoryPickerDialog } from "@/components/mock-directory-picker-dialog";
import { useEffect } from "react";
import { useTheme } from "@/components/theme-provider";
import { platformAdapter } from "@/adapters";
import { isWeb } from "@/utils/platform";
import { Loader } from "./components/loader";

export const App = () => {
  const { setTheme } = useTheme();

  useEffect(() => {
    const cleanup = platformAdapter.addThemeListener((theme) => {
      setTheme(theme);
    });

    return cleanup;
  }, [setTheme]);

  return (
    <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      {/* Only render mock directory picker in browser/web mode */}
      {isWeb() && <MockDirectoryPickerDialog />}
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
  );
};
