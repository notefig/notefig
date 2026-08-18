import { useContext, useMemo } from "react";
import { UNSAFE_RouteContext as RouteContext } from "react-router-dom";
import { Loader } from "@/components/loader";
import { Workspace } from "@/components/workspace";
import { WorkspaceErrorBoundary } from "@/components/workspace-error-boundary";
import { WORKSPACE_ROOT } from "./content-manifest";

/**
 * A route match that exists only to carry `basePath`. `pathnameBase: "/"`
 * matters: react-router resolves relative navigations against it, and the
 * app writes its layout with a relative `?layout=…` navigation.
 */
const WORKSPACE_MATCH = {
  params: { basePath: WORKSPACE_ROOT },
  pathname: "/",
  pathnameBase: "/",
  route: { id: "marketing-workspace", path: "/" },
};

/**
 * The real Workspace, rooted at the seeded workspace whatever the URL is.
 *
 * The core `useWorkspaceParams` derives the workspace root from a route
 * param, but this site's URLs mirror the content tree (`/`, `/docs/cli`,
 * `/download`) and never name the workspace. Rather than change that hook —
 * `Loader`, `WorkspaceErrorBoundary`, `Workspace` and `use-recent-projects`
 * all read it — we hand the subtree a route match that supplies the param.
 *
 * Deliberately NOT `<Routes location={...}>`: overriding the location also
 * replaces `LocationContext`, and react-router resolves a relative
 * navigation (`navigate("?layout=…")`, which is how the workspace persists
 * its tabs) against the location pathname. With a fake pathname every layout
 * write landed on `/<root>`, which is not a page of this site — one tab
 * click and the visitor was bounced to the landing page. Faking only the
 * params leaves location, search and navigation entirely real.
 */
export function AppSurface() {
  const parent = useContext(RouteContext);
  const context = useMemo(
    () => ({ ...parent, matches: [WORKSPACE_MATCH] }),
    [parent],
  );

  return (
    <RouteContext.Provider value={context}>
      <Loader>
        <WorkspaceErrorBoundary>
          <Workspace />
        </WorkspaceErrorBoundary>
      </Loader>
    </RouteContext.Provider>
  );
}
