import { useEffect, useRef } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { AppSurface } from "./app-surface";
import { type MarketingPage } from "./content-manifest";
import { Hero } from "./hero";
import { MarketingHeader } from "./marketing-header";
import { usePrerenderHandoff } from "./prerender";
import { pageForPathname, titleForRoute } from "./route-page";
import { RUNWAY_VH, useAppTakeover } from "./use-app-takeover";
import { usePageIsEmpty, useWorkspaceReady } from "./use-workspace-ready";

/**
 * The whole site: one page, always. A short hero on top and the real app
 * directly under it, which grows into the full viewport as the visitor
 * scrolls (see use-app-takeover.ts). `/docs/cli` and `/download` are the same
 * page with a different file open and the app already taken over — those URLs
 * exist so each page has something crawlable and shareable of its own, not
 * because there is a second site to visit.
 */
export function SiteShell() {
  const location = useLocation();
  const page = pageForPathname(location.pathname);
  if (!page) return <Navigate to="/" replace />;
  return <SitePage page={page} isDeepLink={location.pathname !== "/"} />;
}

function SitePage({
  page,
  isDeepLink,
}: {
  page: MarketingPage;
  isDeepLink: boolean;
}) {
  const workspaceReady = useWorkspaceReady(page);
  const { runwayRef, stageRef, frameRef, scrollToApp, jumpToApp } =
    useAppTakeover();

  const pageIsEmpty = usePageIsEmpty(page, workspaceReady);
  usePrerenderHandoff(workspaceReady ? ".ProseMirror" : ".never", {
    allowEmpty: pageIsEmpty,
  });
  useDocumentTitle(page, isDeepLink);

  // A visitor arriving on a page URL (search result, shared link) came for
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
      <Hero activeRoute={page.route} onEnterApp={scrollToApp} />

      <section
        ref={runwayRef as React.RefObject<HTMLElement>}
        style={{ height: `${RUNWAY_VH}vh` }}
        className="relative"
      >
        {/* No clipping: the frame's shadow is what lifts it off the page. */}
        <div className="sticky top-0 h-screen">
          <div
            ref={frameRef as React.RefObject<HTMLDivElement>}
            className="app-frame absolute inset-0 overflow-hidden bg-background"
          >
            {workspaceReady && <AppSurface />}
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
function useDocumentTitle(page: MarketingPage, isDeepLink: boolean): void {
  useEffect(() => {
    document.title = titleForRoute(page, isDeepLink);
  }, [page, isDeepLink]);
}
