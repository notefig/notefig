// MUST be first: when VITE_TEST_BACKEND=shim, installs window.__TAURI_INTERNALS__
// so the app picks the real Tauri adapter and routes invoke/events to the e2e
// shim — before anything reads the platform or the platformAdapter singleton.
// No-op (dead-code-eliminated) in normal builds. (MET-73)
import "@/testing/shim-transport";
import { Buffer } from "buffer";
import "./utils/intl";
import { ThemeProvider } from "@/components/theme-provider";
import { AppUpdaterBootstrap } from "@/components/app-updater";
import { TelemetryBootstrap } from "@/components/telemetry-bootstrap";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@notefig/ui/tooltip";
import { App } from "./App";
import { desktopModules } from "@/core/app-core";
import { startApp } from "@/core/start-app";

import "./styles.css";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

startApp({
  modules: desktopModules(),
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
});
