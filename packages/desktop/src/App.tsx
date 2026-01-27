import { listen } from "@tauri-apps/api/event";
import "./App.css";
import { Routes, Route } from "react-router-dom";
import { Workspace } from "@/components/workspace";
import { Welcome } from "@/components/welcome";
import { useEffect } from "react";
import { useTheme, type Theme } from "@/components/theme-provider";

export const App = () => {
  const { setTheme } = useTheme();
  useEffect(() => {
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
