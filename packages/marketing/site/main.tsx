// MUST be first: forces the IndexedDB fs adapter before the platformAdapter
// module-eval singleton is touched by any other import.
import "./force-indexeddb";
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Buffer } from "buffer";
import { BrowserRouter } from "react-router-dom";
import "@/utils/intl";
import { ThemeProvider } from "@/components/theme-provider";
import { TextPromptDialog } from "@/components/text-prompt-dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { queryClient } from "@/entities/query-client";
import { SiteShell } from "./site-shell";
import { marketingDocs } from "./content-manifest";

// The site-local wrapper around @/styles.css — registers the desktop source
// tree with Tailwind, whose auto-detection cannot see outside this package.
import "./styles.css";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

// The prerender script (scripts/prerender.mjs) reads the route list and
// per-page metadata from the running app, so the manifest never needs a
// second, node-side frontmatter parser.
(window as unknown as { __MARKETING_ROUTES__: unknown }).__MARKETING_ROUTES__ =
  marketingDocs.map(({ slug, title, description }) => ({
    slug,
    title,
    description,
  }));

// The site scrolls, and it decides its own scroll position on arrival
// (top for `/`, the app for a deep link) — a restored offset would land the
// visitor mid-transition.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";

/**
 * The marketing composition root: the same app, assembled without the
 * desktop-only surfaces (updater, telemetry, tunnel pairing, welcome flow).
 * Every URL renders the same shell, so the workspace survives navigation.
 */
const MarketingApp = () => (
  <>
    <TextPromptDialog />
    <SiteShell />
  </>
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
