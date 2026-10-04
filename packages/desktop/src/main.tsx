// MUST be first: when VITE_TEST_BACKEND=shim, installs window.__TAURI_INTERNALS__
// so the app picks the real Tauri adapter and routes invoke/events to the e2e
// shim — before anything reads the platform or the platformAdapter singleton.
// No-op (dead-code-eliminated) in normal builds. (MET-73)
import "@/testing/shim-transport";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Buffer } from "buffer";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./utils/intl";
import { ThemeProvider } from "@/components/theme-provider";
import { AppUpdaterBootstrap } from "@/components/app-updater";
import { TelemetryBootstrap } from "@/components/telemetry-bootstrap";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@notefig/ui/tooltip";
import { queryClient } from "@/entities/query-client";
import { App } from "./App";
import { CoreProvider } from "@notefig/core/react";
import { createAppCore, desktopModules } from "@/core/app-core";
import { urlStateFromRouter } from "@/entities/layout";

import "./styles.css";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

// A data router, so the URL (which carries the tab layout) can be read and
// navigated outside React. One splat route: App's own <Routes> do the rest.
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <ThemeProvider>
        <TooltipProvider>
          <AppUpdaterBootstrap />
          <TelemetryBootstrap />
          <App />
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    ),
  },
]);

const core = createAppCore(desktopModules(), {
  url: urlStateFromRouter(router),
});
core.boot();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CoreProvider core={core}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </CoreProvider>
  </React.StrictMode>,
);
