import { useEffect, useMemo, useState } from "react";
import {
  Link,
  Navigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { Loader } from "@/components/loader";
import { Workspace } from "@/components/workspace";
import { WorkspaceErrorBoundary } from "@/components/workspace-error-boundary";
import { platformAdapter } from "@/adapters";
import { LAYOUT_PARAM, parseLayout } from "@/utils/layout-codec";
import {
  findWindowContainingTab,
  openFileInLayout,
} from "@/utils/dockable-layout";
import { cn } from "@/lib/utils";
import {
  MARKETING_WORKSPACE,
  defaultDoc,
  findDoc,
  marketingDocs,
} from "./content-manifest";
import { ensureMarketingWorkspaceSeeded } from "./seed";
import { usePrerenderHandoff } from "./prerender";

// One seed per page load, shared by every docs route mount.
let seedPromise: Promise<void> | null = null;
function seedOnce(): Promise<void> {
  seedPromise ??= ensureMarketingWorkspaceSeeded(platformAdapter.fs);
  return seedPromise;
}

function DocsSidebar({ activeSlug }: { activeSlug: string }) {
  return (
    <nav
      aria-label="Documentation"
      className="w-56 shrink-0 overflow-y-auto border-r border-border bg-background p-3"
    >
      <ul className="flex flex-col gap-0.5 text-sm">
        {marketingDocs.map((doc) => (
          <li key={doc.slug}>
            <Link
              to={`/docs/${doc.slug}`}
              className={cn(
                "block rounded-md px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground",
                doc.slug === activeSlug &&
                  "bg-accent font-medium text-foreground",
              )}
            >
              {doc.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * `/docs` and `/docs/:slug`, matched via `/:basePath/:slug?` so that
 * `useWorkspaceParams` reads the workspace root ("docs") straight from the
 * URL — the core Workspace runs unmodified. The slug's file is enforced
 * into the `?layout=` param (the layout's single source of truth) with
 * history *replacement*, so anchors and canonicals stay clean while the
 * workspace keeps its normal tab semantics on top.
 */
export function DocsRoute() {
  const params = useParams<{ basePath?: string; slug?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [seeded, setSeeded] = useState(false);

  const doc = params.slug ? findDoc(params.slug) : defaultDoc;

  useEffect(() => {
    let cancelled = false;
    void seedOnce().then(() => {
      if (!cancelled) setSeeded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const layoutParam = searchParams.get(LAYOUT_PARAM);
  const tabId = doc?.path ?? null;
  const needsLayoutWrite = useMemo(() => {
    if (!tabId) return false;
    const layout = parseLayout(layoutParam);
    const window = findWindowContainingTab(layout, tabId);
    return !window || window.selected !== tabId;
  }, [layoutParam, tabId]);

  useEffect(() => {
    if (!tabId || !needsLayoutWrite) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const layout = openFileInLayout(parseLayout(next.get(LAYOUT_PARAM)), {
          tabId,
          intent: "replace",
        });
        next.set(LAYOUT_PARAM, JSON.stringify(layout));
        return next;
      },
      { replace: true },
    );
  }, [tabId, needsLayoutWrite, setSearchParams]);

  usePrerenderHandoff(seeded && !needsLayoutWrite ? ".ProseMirror" : ".never");

  if (params.basePath !== MARKETING_WORKSPACE || !doc) {
    return <Navigate to="/docs" replace />;
  }

  return (
    <div className="flex min-h-0 flex-1">
      <DocsSidebar activeSlug={doc.slug} />
      <div className="min-w-0 flex-1">
        {seeded && !needsLayoutWrite && (
          <Loader>
            <WorkspaceErrorBoundary>
              <Workspace />
            </WorkspaceErrorBoundary>
          </Loader>
        )}
      </div>
    </div>
  );
}
