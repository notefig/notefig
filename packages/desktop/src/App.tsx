import "./App.css";
import { Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { Workspace } from "@/components/workspace";

export const App = () => {
  return (
    <ThemeProvider>
      <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
        <Routes>
          {/* Edit route - file selected for editing (most specific first) */}
          <Route path="/:basePath/edit/*" element={<Workspace />} />
          {/* Base path route - no file selected */}
          <Route path="/:basePath" element={<Workspace />} />
          {/* Root route - no directory selected */}
          <Route path="/" element={<Workspace />} />
        </Routes>
      </div>
    </ThemeProvider>
  );
};
