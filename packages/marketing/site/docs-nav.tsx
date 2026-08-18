import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { adjacentDocs, marketingDocs, type MarketingDoc } from "./content-manifest";

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
  children,
}: {
  slug: string;
  className?: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      if (!isPlainLeftClick(event)) return; // new tab / download / etc.
      event.preventDefault();
      navigate({ pathname: `/docs/${slug}`, search: location.search });
    },
    [navigate, location.search, slug],
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

function AdjacentLink({
  doc,
  direction,
}: {
  doc: MarketingDoc;
  direction: "previous" | "next";
}) {
  const isNext = direction === "next";
  return (
    <DocsLink
      slug={doc.slug}
      className={cn(
        "group flex max-w-[48%] items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground",
        isNext && "ml-auto flex-row-reverse text-right",
      )}
    >
      {isNext ? (
        <ChevronRight className="size-4 shrink-0" aria-hidden="true" />
      ) : (
        <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
      )}
      <span className="truncate">
        <span className="text-xs uppercase tracking-wide opacity-60">
          {direction}
        </span>{" "}
        {doc.title}
      </span>
    </DocsLink>
  );
}

/**
 * The docs link graph, present on every page (and therefore in every
 * prerendered snapshot). The file tree is the primary navigation for humans,
 * but it renders into a shadow root and its rows are not anchors, so it is
 * invisible to crawlers — without this footer every doc page would be an
 * orphan reachable only from sitemap.xml.
 */
export function DocsFooterNav({ activeSlug }: { activeSlug: string }) {
  const { previous, next } = adjacentDocs(activeSlug);

  return (
    // The app's status bar is `fixed bottom-0 right-0`; the bottom padding
    // leaves it a strip to sit in instead of covering the link list.
    <footer className="shrink-0 border-t border-border bg-background px-4 pb-9 pt-3">
      {(previous || next) && (
        <div className="mb-3 flex items-center gap-4">
          {previous && <AdjacentLink doc={previous} direction="previous" />}
          {next && <AdjacentLink doc={next} direction="next" />}
        </div>
      )}
      <nav aria-label="All documentation">
        <h2 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
          All documentation
        </h2>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {marketingDocs.map((doc) => (
            <li key={doc.slug}>
              <DocsLink
                slug={doc.slug}
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
    </footer>
  );
}
