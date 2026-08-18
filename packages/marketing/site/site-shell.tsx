import { useEffect, useRef } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { AppSurface } from "./app-surface";
import { type MarketingDoc } from "./content-manifest";
import { Hero } from "./hero";
import { MarketingHeader } from "./marketing-header";
import { usePrerenderHandoff } from "./prerender";
import { docForPathname, titleForRoute } from "./route-doc";
import { RUNWAY_VH, useAppTakeover } from "./use-app-takeover";
import { useDocsWorkspaceReady } from "./use-docs-workspace";

/**
 * The whole site: one page, always. A short hero on top and the real app
 * directly under it, which grows into the full viewport as the visitor
 * scrolls (see use-app-takeover.ts). `/docs/<slug>` is the same page with a
 * different file open and the app already taken over — that URL exists so
 * each page has something crawlable and shareable of its own, not because
 * there is a separate docs site to visit.
 */
export function SiteShell() {
  const location = useLocation();
  const doc = docForPathname(location.pathname);
  if (!doc) return <Navigate to="/" replace />;
  return <SitePage doc={doc} isDeepLink={location.pathname !== "/"} />;
}

function SitePage({
  doc,
  isDeepLink,
}: {
  doc: MarketingDoc;
  isDeepLink: boolean;
}) {
  const workspaceReady = useDocsWorkspaceReady(doc);
  const { runwayRef, stageRef, frameRef, scrollToApp, jumpToApp } =
    useAppTakeover();

  usePrerenderHandoff(workspaceReady ? ".ProseMirror" : ".never");
  useDocumentTitle(doc, isDeepLink);

  // A visitor arriving on /docs/<slug> (search result, shared link) came for
  // that page, so start immersed — the hero is still one scroll up. Landing
  // on `/` always starts at the top, whatever the browser restored.
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || !workspaceReady) return;
    jumped.current = true;
    if (isDeepLink) jumpToApp();
    else window.scrollTo({ top: 0 });
  }, [workspaceReady, isDeepLink, jumpToApp]);

  return (
    <div
      ref={stageRef as React.RefObject<HTMLDivElement>}
      className="site-stage bg-background text-foreground"
    >
      <MarketingHeader onEnterApp={scrollToApp} />
      <Hero onEnterApp={scrollToApp} />

      <section
        ref={runwayRef as React.RefObject<HTMLElement>}
        style={{ height: `${RUNWAY_VH}vh` }}
        className="relative"
      >
        <div className="sticky top-0 h-screen overflow-hidden">
          <div
            ref={frameRef as React.RefObject<HTMLDivElement>}
            className="app-frame absolute inset-0 overflow-hidden bg-background"
          >
            {workspaceReady && <AppSurface slug={doc.slug} />}
            <div
              className="app-veil pointer-events-none absolute inset-0 bg-background"
              aria-hidden="true"
            />
          </div>
          {/* Until the app owns the viewport, a click on it means "let me in"
              rather than "put the caret there". */}
          <button
            type="button"
            className="app-enter absolute inset-0 cursor-pointer"
            onClick={scrollToApp}
          >
            <span className="sr-only">Open the app full screen</span>
          </button>
        </div>
      </section>
    </div>
  );
}

/** Keeps the tab title in step with SPA navigation and the prerendered HTML. */
function useDocumentTitle(doc: MarketingDoc, isDeepLink: boolean): void {
  useEffect(() => {
    document.title = titleForRoute(doc, isDeepLink);
  }, [doc, isDeepLink]);
}
