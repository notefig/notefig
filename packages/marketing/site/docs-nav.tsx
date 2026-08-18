import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { marketingDocs } from "./content-manifest";

/**
 * A docs anchor whose `href` is always the clean canonical path, while an
 * in-app click preserves the current `?layout=` (the visitor's open tabs).
 *
 * Putting the layout in the href instead would mint a crawlable URL variant
 * per page pair — indexing noise the canonical tag has to mop up — and would
 * bake one visitor's tab set into the prerendered HTML.
 */
export function DocsLink({
  slug,
  className,
  onNavigate,
  children,
}: {
  slug: string;
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
      navigate({ pathname: `/docs/${slug}`, search: location.search });
      onNavigate?.();
    },
    [navigate, location.search, slug, onNavigate],
  );

  return (
    <a href={`/docs/${slug}`} onClick={handleClick} className={className}>
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
 * The docs link graph, rendered in the hero and therefore present in every
 * prerendered snapshot. The workspace's file tree is the primary navigation
 * for humans, but it renders into a shadow root and its rows are not
 * anchors — without these links every page would be an orphan reachable only
 * from sitemap.xml.
 */
export function DocsLinkRow({
  activeSlug,
  onNavigate,
}: {
  activeSlug?: string;
  onNavigate?: () => void;
}) {
  return (
    <nav aria-label="Documentation" className="max-w-3xl">
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
        Open a page below
      </h2>
      <ul className="flex flex-wrap gap-x-3 gap-y-1.5 text-sm">
        {marketingDocs.map((doc) => (
          <li key={doc.slug}>
            <DocsLink
              slug={doc.slug}
              onNavigate={onNavigate}
              className={cn(
                "text-muted-foreground hover:text-foreground hover:underline",
                doc.slug === activeSlug && "font-medium text-foreground",
              )}
            >
              {doc.title}
            </DocsLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}
