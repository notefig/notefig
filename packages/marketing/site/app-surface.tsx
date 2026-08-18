import { Route, Routes, useLocation } from "react-router-dom";
import { Loader } from "@/components/loader";
import { Workspace } from "@/components/workspace";
import { WorkspaceErrorBoundary } from "@/components/workspace-error-boundary";
import { MARKETING_WORKSPACE } from "./content-manifest";

/**
 * The real Workspace, rooted at the seeded `docs` workspace whatever the
 * browser URL happens to be.
 *
 * The core `useWorkspaceParams` derives the workspace root from a route
 * param, but this site serves the app from `/` as well as `/docs/<slug>`.
 * Instead of changing that hook, the app is mounted under a nested `<Routes>`
 * with an overridden location: matching sees `/docs/<slug>` (so the param
 * exists and equals the workspace root), while `search` — where the app keeps
 * its layout state — is passed through untouched from the real location.
 *
 * One route, one element position: the workspace stays mounted across every
 * `/` ↔ `/docs/<slug>` navigation instead of being torn down and rebuilt.
 */
export function AppSurface({ slug }: { slug: string }) {
  const location = useLocation();

  return (
    <Routes
      location={{
        ...location,
        pathname: `/${MARKETING_WORKSPACE}/${slug}`,
      }}
    >
      <Route
        path="/:basePath/:slug?"
        element={
          <Loader>
            <WorkspaceErrorBoundary>
              <Workspace />
            </WorkspaceErrorBoundary>
          </Loader>
        }
      />
    </Routes>
  );
}
