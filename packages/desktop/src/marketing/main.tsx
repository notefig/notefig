// MUST be first: forces the IndexedDB fs adapter before the platformAdapter
// module-eval singleton is touched by any other import.
import "./force-indexeddb";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Buffer } from "buffer";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "@/utils/intl";
import { ThemeProvider } from "@/components/theme-provider";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/entities/query-client";
import { MarketingHeader } from "./marketing-header";
import { Landing } from "./landing";
import { DocsRoute } from "./docs-route";

import "@/styles.css";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

/**
 * The marketing composition root: the same app, assembled without the
 * desktop-only surfaces (updater, telemetry, tunnel pairing, welcome flow).
 * Routes `/docs/:slug` through `/:basePath/:slug?` so the unmodified core
 * Workspace derives its workspace root from the URL.
 */
const MarketingApp = () => (
  <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
    <MarketingHeader />
    <TextPromptDialog />
    <div className="flex min-h-0 flex-1 flex-col">
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/:basePath/:slug?" element={<DocsRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  </div>
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ThemeProvider>
          <TooltipProvider>
            <MarketingApp />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
