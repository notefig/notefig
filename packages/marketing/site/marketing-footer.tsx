import { ArrowUpRight } from "lucide-react";
import { findPageByRoute } from "./content-manifest";
import { APP_URL, GITHUB_URL, RELEASES_URL } from "./links";
import { PageLink } from "./page-links";

/**
 * A compact footer: the mark, the product links, the copyright. The site's
 * only page besides the landing (the Download page) is linked here, so it is
 * not an orphan reachable only from sitemap.xml.
 */
export function MarketingFooter({ onEnterApp }: { onEnterApp: () => void }) {
  const download = findPageByRoute("/download");
  return (
    <footer className="mk-footer">
      <div className="site-column flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2 text-[18px] font-semibold tracking-[-0.02em]">
          <img src="/icon.svg" alt="" className="size-6" aria-hidden="true" />
          Notefig
        </div>
        <nav
          aria-label="Footer"
          className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:gap-x-6"
        >
          <ExternalLink href={APP_URL}>Web app</ExternalLink>
          {download && (
            <PageLink page={download} onNavigate={onEnterApp} className="mk-footer-link">
              Download
            </PageLink>
          )}
          <ExternalLink href={GITHUB_URL}>GitHub</ExternalLink>
          <ExternalLink href={RELEASES_URL}>Releases</ExternalLink>
        </nav>
      </div>
      <div className="site-column border-t border-[rgb(247_239_231/0.12)] py-5 text-[13px] font-medium text-[var(--mk-blush)] opacity-80">
        © {new Date().getFullYear()} Notefig. Open source under the MIT license.
      </div>
    </footer>
  );
}

/** A link off the site: new tab, with the ↗ that says so. */
function ExternalLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className="mk-footer-link inline-flex items-center gap-0.5"
    >
      {children}
      <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
    </a>
  );
}
