import { Link } from "react-router-dom";
import { APP_URL, GITHUB_URL, RELEASES_URL } from "./links";

/**
 * Site chrome: real anchors on every page so crawlers can reach the app and
 * the repo from anywhere. Fades out as the app takes over the viewport (see
 * `.site-header` in styles.css) and comes back as soon as the visitor
 * scrolls up towards the hero.
 */
export function MarketingHeader({ onEnterApp }: { onEnterApp: () => void }) {
  return (
    <header className="site-header fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-4 border-b border-border/60 bg-background/80 px-5 backdrop-blur">
      <Link to="/" className="flex items-center gap-2 font-semibold">
        <img src="/icon.svg" alt="" className="size-5" aria-hidden="true" />
        <span>Notefig</span>
      </Link>
      <nav className="flex flex-1 items-center gap-4 text-sm">
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
        <a
          href={RELEASES_URL}
          className="hidden text-muted-foreground hover:text-foreground sm:block"
          rel="noopener"
        >
          Download
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
