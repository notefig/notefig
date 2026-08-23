import { Link } from "react-router-dom";
import { APP_URL, GITHUB_URL, MACOS_DOWNLOAD_URL } from "./links";

export function MarketingHeader({ onEnterApp }: { onEnterApp: () => void }) {
  return (
    <header className="sticky top-0 z-40 h-12 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="site-column flex h-full items-center gap-4">
        <Link to="/" className="flex items-center gap-2 text-sm font-semibold">
          <img src="/icon.svg" alt="" className="size-4" aria-hidden="true" />
          <span>Notefig</span>
        </Link>
        <nav className="hidden items-center gap-4 text-xs sm:flex">
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
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <a
            href={APP_URL}
            target="_blank"
            rel="noopener"
            className="whitespace-nowrap rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Open the app
          </a>
          <a
            href={MACOS_DOWNLOAD_URL}
            download
            className="whitespace-nowrap rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-accent"
          >
            Download for macOS
          </a>
        </div>
      </div>
    </header>
  );
}
