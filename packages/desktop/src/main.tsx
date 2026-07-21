// MUST be first: when VITE_TEST_BACKEND=shim, installs window.__TAURI_INTERNALS__
// so the app picks the real Tauri adapter and routes invoke/events to the e2e
// shim — before anything reads the platform or the platformAdapter singleton.
// No-op (dead-code-eliminated) in normal builds. (MET-73)
import "@/testing/shim-transport";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Buffer } from "buffer";
import { BrowserRouter } from "react-router-dom";
import "./utils/intl";
import { ThemeProvider } from "@/components/theme-provider";
import { AppUpdaterBootstrap } from "@/components/app-updater";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/entities/query-client";
import { App } from "./App";

import "./styles.css";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <TooltipProvider>
            <AppUpdaterBootstrap />
            <App />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
