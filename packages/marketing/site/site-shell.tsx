import { useEffect, useRef } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { AppSurface } from "./app-surface";
import { type MarketingPage } from "./content-manifest";
import { Hero } from "./hero";
import { MarketingFooter } from "./marketing-footer";
import { MarketingHeader } from "./marketing-header";
import { MarketingSections } from "./marketing-sections";
import { marketingHandoff, usePrerenderHandoff } from "./prerender";
import { pageForPathname, titleForRoute } from "./route-page";
import {
  useMobileProductShot,
  useProductWindow,
} from "./use-product-window";
import { usePageIsEmpty, useWorkspaceReady } from "./use-workspace-ready";

/**
 * One page: hero, a framed live app (product shot, not a takeover), then
 * marketing sections. `/docs/cli` and `/download` are the same page with a
 * different file open — those URLs exist so each page is crawlable.
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
  const isMobileShot = useMobileProductShot();
  const workspaceReady = useWorkspaceReady(page);
  const product = useProductWindow(isDeepLink);
  const pageIsEmpty = usePageIsEmpty(page, workspaceReady && !isMobileShot);
  const handoff = marketingHandoff(isMobileShot, workspaceReady, pageIsEmpty);

  usePrerenderHandoff(handoff.selector, { allowEmpty: handoff.allowEmpty });
  useDocumentTitle(page, isDeepLink);
  useArriveAtApp(isMobileShot, workspaceReady, isDeepLink, product.jumpToApp);

  return (
    <div className="site-stage bg-background text-foreground">
      <div className="select-text">
        <MarketingHeader onEnterApp={product.scrollToApp} />
        <Hero />
      </div>
      <ProductStage
        frameRef={product.frameRef}
        live={product.live}
        isMobileShot={isMobileShot}
        workspaceReady={workspaceReady}
        onEnterApp={product.scrollToApp}
      />
      <div className="select-text">
        <MarketingSections />
        <MarketingFooter onEnterApp={product.scrollToApp} />
      </div>
    </div>
  );
}

function useArriveAtApp(
  isMobileShot: boolean,
  workspaceReady: boolean,
  isDeepLink: boolean,
  jumpToApp: () => void,
): void {
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current) return;
    if (!isMobileShot && !workspaceReady) return;
    jumped.current = true;
    if (isDeepLink) jumpToApp();
    else window.scrollTo({ top: 0 });
  }, [isMobileShot, workspaceReady, isDeepLink, jumpToApp]);
}

function ProductStage({
  frameRef,
  live,
  isMobileShot,
  workspaceReady,
  onEnterApp,
}: {
  frameRef: React.RefObject<HTMLElement | null>;
  live: boolean;
  isMobileShot: boolean;
  workspaceReady: boolean;
  onEnterApp: () => void;
}) {
  return (
    <section
      ref={frameRef as React.RefObject<HTMLElement>}
      className="site-column product-window relative pb-8"
    >
      <img
        src="/app-preview-desktop.png"
        alt="The Notefig homepage: stone paper page around a framed dark editor"
        className="product-shot"
      />
      <div className="product-live">
        <div className="product-chrome" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="relative">
          <div
            className="product-frame dark"
            {...(!live ? { inert: true } : {})}
          >
            {!isMobileShot && workspaceReady && <AppSurface />}
          </div>
          {!live && (
            <button
              type="button"
              className="absolute inset-0 cursor-pointer"
              onClick={onEnterApp}
            >
              <span className="sr-only">Open the app</span>
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function useDocumentTitle(page: MarketingPage, isDeepLink: boolean): void {
  useEffect(() => {
    document.title = titleForRoute(page, isDeepLink);
  }, [page, isDeepLink]);
}
