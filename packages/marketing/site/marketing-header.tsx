import { Link } from "react-router-dom";
import { findPageByRoute } from "./content-manifest";
import { APP_URL, GITHUB_URL, RELEASES_URL } from "./links";
import { PageLink } from "./page-links";

const DOWNLOAD_PAGE = findPageByRoute("/download");

/**
 * Site chrome: real anchors on every page so crawlers can reach the app and
 * the repo from anywhere. Fades out as the app takes over the viewport (see
 * `.site-header` in styles.css) and comes back as soon as the visitor
 * scrolls up towards the hero.
 */
export function MarketingHeader({ onEnterApp }: { onEnterApp: () => void }) {
  return (
    <header className="site-header fixed inset-x-0 top-0 z-40 h-12 border-b border-border/60 bg-background/80 backdrop-blur">
      {/* Same column as the app below, so the wordmark sits on its edge. */}
      <div className="site-column flex h-full items-center gap-4">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
          <img src="/icon.svg" alt="" className="size-4" aria-hidden="true" />
          <span>Notefig</span>
        </Link>
        {/* Below sm the links wrap and push the bar to two rows; the app
            below is reachable by scrolling, so they step aside. */}
        <nav className="hidden flex-1 items-center gap-4 text-xs sm:flex">
          <button
            type="button"
            onClick={onEnterApp}
            className="text-muted-foreground hover:text-foreground"
          >
            Docs
          </button>
          <a
            href={GITHUB_URL}
            className="text-muted-foreground hover:text-foreground"
            rel="noopener"
          >
            GitHub
          </a>
          {DOWNLOAD_PAGE ? (
            <PageLink
              page={DOWNLOAD_PAGE}
              onNavigate={onEnterApp}
              className="hidden text-muted-foreground hover:text-foreground sm:block"
            >
              Download
            </PageLink>
          ) : (
            <a
              href={RELEASES_URL}
              className="hidden text-muted-foreground hover:text-foreground sm:block"
              rel="noopener"
            >
              Download
            </a>
          )}
        </nav>
        <a
          href={APP_URL}
          className="ml-auto whitespace-nowrap rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 sm:ml-0"
        >
          Open the app
        </a>
      </div>
    </header>
  );
}
