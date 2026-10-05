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
import { urlStateFromRouter } from "@/entities/layout";
import { queryClient } from "@/entities/query-client";
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

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <CoreProvider core={core}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </CoreProvider>
    </StrictMode>,
  );
  return core;
}
