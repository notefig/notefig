import { useEffect } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Loader } from "@/components/loader";
import { Workspace } from "@/components/workspace";
import { WorkspaceErrorBoundary } from "@/components/workspace-error-boundary";
import {
  MARKETING_WORKSPACE,
  defaultDoc,
  findDoc,
  type MarketingDoc,
} from "./content-manifest";
import { DocsFooterNav } from "./docs-nav";
import { usePrerenderHandoff } from "./prerender";
import { useDocsWorkspaceReady } from "./use-docs-workspace";

function DocsPage({ doc }: { doc: MarketingDoc }) {
  const workspaceReady = useDocsWorkspaceReady(doc);
  usePrerenderHandoff(workspaceReady ? ".ProseMirror" : ".never");

  // Prerendered pages carry per-route titles; keep SPA navigation (sidebar,
  // file tree, back/forward) consistent with them.
  useEffect(() => {
    document.title = `${doc.title} — Notefig Docs`;
  }, [doc.title]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 min-w-0 flex-1">
        {workspaceReady && (
          <Loader>
            <WorkspaceErrorBoundary>
              <Workspace />
            </WorkspaceErrorBoundary>
          </Loader>
        )}
      </div>
      <DocsFooterNav activeSlug={doc.slug} />
    </div>
  );
}

/**
 * `/docs` and `/docs/:slug`, matched via `/:basePath/:slug?` so that
 * `useWorkspaceParams` reads the workspace root ("docs") straight from the
 * URL — the core Workspace runs unmodified. This wrapper only resolves the
 * slug; seeding and layout enforcement live in use-docs-workspace.ts.
 */
export function DocsRoute() {
  const params = useParams<{ basePath?: string; slug?: string }>();
  const doc = params.slug ? findDoc(params.slug) : defaultDoc;

  if (params.basePath !== MARKETING_WORKSPACE || !doc) {
    return <Navigate to="/docs" replace />;
  }

  return <DocsPage doc={doc} />;
}
