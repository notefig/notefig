import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { platformAdapter } from "@/adapters";
import { LAYOUT_PARAM, parseLayout } from "@/utils/layout-codec";
import type { LayoutNode } from "@/components/dockable";
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

/**
 * True when the page's file has no text of its own — because the visitor
 * emptied it, since their edits persist. The prerender handoff waits for
 * rendered text as proof the app has caught up with the snapshot, which an
 * emptied page can never produce; this tells it that empty is the truth.
 */
export function usePageIsEmpty(page: MarketingPage, enabled: boolean): boolean {
  const [isEmpty, setIsEmpty] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void platformAdapter.fs.readFiles([page.filePath]).then((result) => {
      const content = result.succeeded[0]?.content ?? "";
      if (!cancelled) setIsEmpty(content.trim().length === 0);
    });
    return () => {
      cancelled = true;
    };
  }, [page.filePath, enabled]);

  return isEmpty;
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

/**
 * Every window's selected tab, in layout order (primary window first).
 * The core's `findLayoutSelectedTab` stops at the first one, which cannot
 * describe a split layout — and the page a link opens may well be selected
 * in the second window rather than the first.
 */
export function selectedTabsInLayout(nodes: LayoutNode[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type === "Window") return node.selected ? [node.selected] : [];
    if (node.type === "Panel") return selectedTabsInLayout(node.children);
    return [];
  });
}

export interface PendingSync {
  /** Which side we wrote and are waiting to observe back. */
  type: "nav" | "layout";
  route: string;
}

/**
 * Has the write recorded in `pending` landed in the router state yet?
 *
 * A layout write settles when the page is selected in ANY window, not just
 * the primary one: `openFileInLayout` selects an already-open tab wherever it
 * lives, so in a split layout the page can land in the second window. Waiting
 * on the primary selection there would never settle, and the reconciler —
 * which stays hands-off until it does — would be dead for the session.
 */
export function isPendingSettled(
  pending: PendingSync,
  pathRoute: string,
  layoutRoutes: readonly string[],
): boolean {
  return pending.type === "nav"
    ? pathRoute === pending.route
    : layoutRoutes.includes(pending.route);
}

export type SyncAction =
  | { kind: "settled"; route: string }
  | { kind: "follow-path"; route: string }
  | { kind: "follow-layout"; route: string }
  | { kind: "none" };

/**
 * Which side of the URL moved, and therefore which side follows. `lastRoute`
 * is the route both sides last agreed on; whichever side no longer matches it
 * is the one the user changed.
 *
 * `layoutRoutes` is every window's selected page, primary window first. The
 * URL is satisfied as long as its page is on screen somewhere; only when it
 * is not does the primary window's selection pull the URL along. Selected
 * files that are not pages of the site (a visitor's own scratch file) are
 * absent from the list, and with nothing to follow the URL stays put.
 */
export function decideSync(
  pathRoute: string,
  layoutRoutes: readonly string[],
  lastRoute: string | null,
): SyncAction {
  if (layoutRoutes.includes(pathRoute)) {
    return { kind: "settled", route: pathRoute };
  }
  if (pathRoute !== lastRoute) return { kind: "follow-path", route: pathRoute };
  const primary = layoutRoutes[0];
  if (primary !== undefined && primary !== lastRoute) {
    return { kind: "follow-layout", route: primary };
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
  const layoutRoutes = useMemo(
    () =>
      selectedTabsInLayout(parseLayout(layoutParam))
        .map((tabId) => findPageByFilePath(tabId)?.route)
        .filter((route): route is string => route !== undefined),
    [layoutParam],
  );

  useEffect(() => {
    const pathRoute = page.route;

    if (
      pendingRef.current &&
      !isPendingSettled(pendingRef.current, pathRoute, layoutRoutes)
    ) {
      return;
    }
    pendingRef.current = null;

    const action = decideSync(pathRoute, layoutRoutes, lastRouteRef.current);
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
    layoutRoutes,
    searchParams,
    setSearchParams,
    navigate,
  ]);

  return initialized;
}
