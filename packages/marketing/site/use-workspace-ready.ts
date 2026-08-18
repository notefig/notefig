import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { platformAdapter } from "@/adapters";
import {
  LAYOUT_PARAM,
  findLayoutSelectedTab,
  parseLayout,
} from "@/utils/layout-codec";
import { openFileInLayout } from "@/utils/dockable-layout";
import { ensureMarketingWorkspaceSeeded } from "./seed";
import { findPageByFilePath, type MarketingPage } from "./content-manifest";

// One seed per page load, shared by every mount.
let seedPromise: Promise<void> | null = null;

/**
 * True once the workspace can mount for this page: content seeded AND the
 * URL layout has been initialized for a page at least once. Deliberately
 * latches — tab interactions inside the workspace must never unmount it.
 */
export function useWorkspaceReady(page: MarketingPage): boolean {
  const seeded = useMarketingSeed();
  const layoutReady = usePageUrlSync(page);
  return seeded && layoutReady;
}

/** True once the marketing workspace content is in IndexedDB. */
function useMarketingSeed(): boolean {
  const [seeded, setSeeded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    seedPromise ??= ensureMarketingWorkspaceSeeded(platformAdapter.fs);
    void seedPromise.then(() => {
      if (!cancelled) setSeeded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return seeded;
}

export interface PendingSync {
  /** Which side we wrote and are waiting to observe back. */
  type: "nav" | "layout";
  route: string;
}

/** Has the write recorded in `pending` landed in the router state yet? */
export function isPendingSettled(
  pending: PendingSync,
  pathRoute: string,
  layoutRoute: string | null,
): boolean {
  return pending.type === "nav"
    ? pathRoute === pending.route
    : layoutRoute === pending.route;
}

export type SyncAction =
  | { kind: "settled"; route: string }
  | { kind: "follow-path"; route: string }
  | { kind: "follow-layout"; route: string }
  | { kind: "none" };

/**
 * Which side of the URL moved, and therefore which side follows. `lastRoute`
 * is the route both sides last agreed on; whichever side no longer matches it
 * is the one the user changed. A selected file that is not a page of the site
 * (layoutRoute null) yields "none" — the URL deliberately stays put.
 */
export function decideSync(
  pathRoute: string,
  layoutRoute: string | null,
  lastRoute: string | null,
): SyncAction {
  if (layoutRoute === pathRoute) return { kind: "settled", route: pathRoute };
  if (pathRoute !== lastRoute) return { kind: "follow-path", route: pathRoute };
  if (layoutRoute !== null && layoutRoute !== lastRoute) {
    return { kind: "follow-layout", route: layoutRoute };
  }
  return { kind: "none" };
}

/**
 * Reconciles the URL path with the `?layout=` param (the workspace's single
 * source of truth for open tabs):
 *
 *   path moved   (a site link, back/forward, first load)
 *                → that page's tab is opened and selected;
 *   layout moved (file tree, tab click, Ctrl+Tab selecting another page)
 *                → the pathname follows.
 *
 * One reconciler, not two competing effects: navigation and layout writes
 * apply asynchronously, so intermediate commits legitimately show one side
 * updated and the other not. `pendingRef` records the write in flight and
 * the reconciler stays hands-off until the router state reflects it —
 * otherwise a half-applied commit reads as user intent and gets "corrected"
 * backwards (the file-tree snap-back this replaced). All writes use history
 * replacement: the entry that initiated the change (link click or the
 * workspace's own layout push) is the one navigation entry.
 */
function usePageUrlSync(page: MarketingPage): boolean {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [initialized, setInitialized] = useState(false);
  const lastRouteRef = useRef<string | null>(null);
  const pendingRef = useRef<PendingSync | null>(null);

  const layoutParam = searchParams.get(LAYOUT_PARAM);
  const selectedTab = useMemo(
    () => findLayoutSelectedTab(parseLayout(layoutParam)),
    [layoutParam],
  );

  useEffect(() => {
    const pathRoute = page.route;
    const layoutRoute = selectedTab
      ? (findPageByFilePath(selectedTab)?.route ?? null)
      : null;

    if (
      pendingRef.current &&
      !isPendingSettled(pendingRef.current, pathRoute, layoutRoute)
    ) {
      return;
    }
    pendingRef.current = null;

    const action = decideSync(pathRoute, layoutRoute, lastRouteRef.current);
    switch (action.kind) {
      case "settled":
        lastRouteRef.current = action.route;
        setInitialized(true);
        break;
      case "follow-path":
        pendingRef.current = { type: "layout", route: action.route };
        lastRouteRef.current = action.route;
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            const layout = openFileInLayout(
              parseLayout(next.get(LAYOUT_PARAM)),
              { tabId: page.filePath, intent: "replace" },
            );
            next.set(LAYOUT_PARAM, JSON.stringify(layout));
            return next;
          },
          { replace: true },
        );
        setInitialized(true);
        break;
      case "follow-layout":
        pendingRef.current = { type: "nav", route: action.route };
        lastRouteRef.current = action.route;
        navigate(
          { pathname: action.route, search: searchParams.toString() },
          { replace: true },
        );
        break;
      case "none":
        break;
    }
  }, [
    page.route,
    page.filePath,
    selectedTab,
    searchParams,
    setSearchParams,
    navigate,
  ]);

  return initialized;
}
