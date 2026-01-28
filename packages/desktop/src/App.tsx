import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { Routes, Route } from "react-router-dom";
import { Workspace } from "@/components/workspace";
import { Welcome } from "@/components/welcome";
import { MockDirectoryPickerDialog } from "@/components/mock-directory-picker-dialog";
import { useEffect } from "react";
import { useTheme, type Theme } from "@/components/theme-provider";
import { isTauri } from "@/utils/platform";

export const App = () => {
  const { setTheme } = useTheme();
  useEffect(() => {
    // Only set up theme listener in Tauri mode
    if (!isTauri()) return;

    const unlisten = listen("theme-changed", (event) => {
      const theme = event.payload as Theme;
      setTheme(theme);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [setTheme]);
  return (
    <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
      <MockDirectoryPickerDialog />
      <Routes>
        {/* Edit route - file selected for editing (most specific first) */}
        <Route path="/:basePath/edit/*" element={<Workspace />} />
        {/* Base path route - no file selected */}
        <Route path="/:basePath" element={<Workspace />} />
        {/* Root route - no directory selected */}
        <Route path="/" element={<Welcome />} />
      </Routes>
    </div>
  );
};
