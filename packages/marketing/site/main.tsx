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
import { TooltipProvider } from "@notefig/ui/tooltip";
import { queryClient } from "@/entities/query-client";
import { bootstrapAppRuntime } from "@/app-runtime";
import {
  closeWorkspace,
  openWorkspace,
  openWorkspacesCollection,
  whenOpenWorkspacesReady,
} from "@/entities/workspaces";
import { workspaceKey } from "@/utils/path";
import { SiteShell } from "./site-shell";
import {
  WORKSPACE_ROOT,
  defaultPage,
  marketingPages,
} from "./content-manifest";

// The site-local wrapper around @/styles.css — registers the desktop source
// tree with Tailwind, whose auto-detection cannot see outside this package.
import "./styles.css";

if (typeof globalThis.Buffer === "undefined") {
  globalThis.Buffer = Buffer;
}

// The same runtime boot the desktop root runs. This root renders the real
// Workspace, so it needs the open-workspace watchers armed exactly as the
// shell does — it just never renders `App`, which is where a React-effect
// version would have lived. It does not restore a persisted open set: the
// site always opens its one seeded root itself.
bootstrapAppRuntime({ restoreWorkspaces: false });

// The one workspace this site ever shows is the seeded content root. The
// open set persists in the visitor's browser, so a root from an earlier
// manifest may still be in it: close anything that is not today's root.
void whenOpenWorkspacesReady().then(() => {
  const rootKey = workspaceKey(WORKSPACE_ROOT);
  for (const row of [...openWorkspacesCollection.values()]) {
    if (row.key !== rootKey) void closeWorkspace(row.path);
  }
  openWorkspace(WORKSPACE_ROOT);
});

// The prerender script (scripts/prerender.mjs) reads the route list and
// per-page metadata from the running app, so the manifest never needs a
// second, node-side frontmatter parser.
(window as unknown as { __MARKETING_ROUTES__: unknown }).__MARKETING_ROUTES__ =
  marketingPages.map(({ route, title, description }) => ({
    route,
    title,
    description,
    // `/` shows this page too, so it is the canonical home for it.
    isDefault: route === defaultPage.route,
  }));

// The site decides its own scroll position on arrival (top for `/`, the
// product window for a deep link).
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
        <ThemeProvider defaultTheme="light">
          <TooltipProvider>
            <MarketingApp />
            <Toaster />
          </TooltipProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
