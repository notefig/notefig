import { APP_URL, GITHUB_URL, MACOS_DOWNLOAD_URL } from "./links";
import { PageLinkRow } from "./page-links";

export function MarketingFooter({ onEnterApp }: { onEnterApp: () => void }) {
  return (
    <footer className="border-t border-border/60 bg-background">
      <div className="site-column flex flex-col gap-8 py-10">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <span className="font-semibold">Notefig</span>
          <a
            href={GITHUB_URL}
            className="text-muted-foreground hover:text-foreground"
            rel="noopener"
          >
            GitHub
          </a>
          <a
            href={APP_URL}
            target="_blank"
            rel="noopener"
            className="text-muted-foreground hover:text-foreground"
          >
            Open the app
          </a>
          <a
            href={MACOS_DOWNLOAD_URL}
            download
            className="ml-auto whitespace-nowrap rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
          >
            Download for macOS
          </a>
        </div>
        <PageLinkRow onNavigate={onEnterApp} />
      </div>
    </footer>
  );
}
