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
import { TelemetryBootstrap } from "@/components/telemetry-bootstrap";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@notefig/ui/tooltip";
import { queryClient } from "@/entities/query-client";
import { App } from "./App";
import { configureCore } from "@notefig/core";
import { desktopHost } from "@/adapters/desktop-host";

import "./styles.css";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

// Before render: the core is reached from module scope by collections and
// registries, so a host has to exist before any of them are touched.
configureCore(desktopHost);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <TooltipProvider>
            <AppUpdaterBootstrap />
            <TelemetryBootstrap />
            <App />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
