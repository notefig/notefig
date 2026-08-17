import { Link, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";

const APP_URL = "https://app.notefig.com";
const GITHUB_URL = "https://github.com/notefig/notefig";

/**
 * Marketing chrome: real anchors on every page so crawlers can discover the
 * docs from anywhere. Rendered by both the landing and docs routes (and
 * therefore present in every prerendered snapshot).
 */
export function MarketingHeader() {
  const location = useLocation();
  const onDocs = location.pathname.startsWith("/docs");

  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-border bg-background px-4">
      <Link to="/" className="flex items-center gap-2 font-semibold">
        <img src="/icon.svg" alt="" className="size-5" aria-hidden="true" />
        <span>Notefig</span>
      </Link>
      <nav className="flex flex-1 items-center gap-3 text-sm">
        <Link
          to="/docs"
          className={cn(
            "text-muted-foreground hover:text-foreground",
            onDocs && "text-foreground",
          )}
        >
          Docs
        </Link>
        <a
          href={GITHUB_URL}
          className="text-muted-foreground hover:text-foreground"
          rel="noopener"
        >
          GitHub
        </a>
      </nav>
      <a
        href={APP_URL}
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
      >
        Open the app
      </a>
    </header>
  );
}
