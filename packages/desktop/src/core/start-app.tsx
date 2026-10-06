/**
 * What every root does once it has chosen its modules and its tree: build
 * the router and the core over it, boot the core, then render. Booting
 * comes first so nothing renders before the subscriptions are live.
 */
import { StrictMode, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import type { AnyModule, Core } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import { urlStateFromRouter } from "@/modules/layout";
import { createAppCore } from "./app-core";

export function startApp({
  modules,
  element,
}: {
  modules: AnyModule[];
  /** The whole app. One splat route: the app's own <Routes> do the rest. */
  element: ReactNode;
}): Core {
  // A data router, so the URL (which carries the tab layout) can be read
  // and navigated outside React.
  const router = createBrowserRouter([{ path: "*", element }]);
  const core = createAppCore(modules, { url: urlStateFromRouter(router) });
  core.boot();
  // Test seam: e2e specs reach the app's own modules (its KV, say) through
  // the core this root built. Dev/test builds only.
  if (import.meta.env.DEV || import.meta.env.VITE_TEST_BACKEND) {
    (window as Window & { __notefigCore?: Core }).__notefigCore = core;
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <CoreProvider core={core}>
        <QueryClientProvider client={core.use("queryClient")}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </CoreProvider>
    </StrictMode>,
  );
  return core;
}
