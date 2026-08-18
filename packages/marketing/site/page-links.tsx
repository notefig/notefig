import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { marketingPages, type MarketingPage } from "./content-manifest";

/**
 * A page anchor whose `href` is always the clean canonical path, while an
 * in-app click preserves the current `?layout=` (the visitor's open tabs).
 *
 * Putting the layout in the href instead would mint a crawlable URL variant
 * per page pair — indexing noise the canonical tag has to mop up — and would
 * bake one visitor's tab set into the prerendered HTML.
 */
export function PageLink({
  page,
  className,
  onNavigate,
  children,
}: {
  page: MarketingPage;
  className?: string;
  onNavigate?: () => void;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainLeftClick(event)) return; // new tab / download / etc.
      event.preventDefault();
      navigate({ pathname: page.route, search: location.search });
      onNavigate?.();
    },
    [navigate, location.search, page.route, onNavigate],
  );

  return (
    <a href={page.route} onClick={handleClick} className={className}>
      {children}
    </a>
  );
}

/** Clicks the browser must keep owning (modified clicks, middle click). */
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.defaultPrevented
  );
}

/**
 * The site's link graph, kept deliberately quiet: the file tree in the app
 * below is how people navigate. It exists because that tree renders into a
 * shadow root and its rows are not anchors, so without these every page would
 * be an orphan reachable only from sitemap.xml.
 */
export function PageLinkRow({
  activeRoute,
  onNavigate,
}: {
  activeRoute?: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="All pages" className="max-w-3xl">
      <ul className="flex flex-wrap gap-x-2.5 gap-y-1 text-xs text-muted-foreground/45">
        {marketingPages.map((page) => (
          <li key={page.route}>
            <PageLink
              page={page}
              onNavigate={onNavigate}
              className={cn(
                "hover:text-muted-foreground hover:underline",
                page.route === activeRoute && "text-muted-foreground",
              )}
            >
              {page.title}
            </PageLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
