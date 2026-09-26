import { ArrowUpRight } from "lucide-react";
import { marketingPages, type MarketingPage } from "./content-manifest";
import { APP_URL, GITHUB_URL, RELEASES_URL } from "./links";
import { Brand } from "./marketing-mocks";
import { PageLink } from "./page-links";

const isPublishingPage = (page: MarketingPage) =>
  page.id === "docs/publishing" || page.id.startsWith("docs/publish-");

/**
 * Black footer with link columns. The page columns are the site's link
 * graph: the file tree in the app renders into a shadow root and its rows
 * are not anchors, so without these every page would be an orphan reachable
 * only from sitemap.xml. Every manifest page must land in a column.
 */
export function MarketingFooter({ onEnterApp }: { onEnterApp: () => void }) {
  const docs = marketingPages.filter(
    (page) => page.id.startsWith("docs/") && !isPublishingPage(page),
  );
  const publishing = marketingPages.filter(isPublishingPage);
  const other = marketingPages.filter((page) => !page.id.startsWith("docs/"));

  return (
    <footer className="mk-footer">
      <div className="site-column grid gap-12 pb-12 pt-20 md:grid-cols-[192px_repeat(3,minmax(0,1fr))] md:gap-8">
        <div className="self-start">
          <div className="flex items-center gap-2 text-[21px] font-semibold tracking-[-0.02em]">
            <img src="/icon.svg" alt="" className="size-7" aria-hidden="true" />
            Notefig
          </div>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener"
            className="mt-5 inline-flex text-[var(--mk-blush)] transition-colors hover:text-[var(--mk-cream)]"
          >
            <Brand name="GitHub" size={18} />
            <span className="sr-only">GitHub</span>
          </a>
        </div>

        <FooterColumn title="Product">
          <li>
            <ExternalLink href={APP_URL}>Open the web app</ExternalLink>
          </li>
          {other.map((page) => (
            <PageItem key={page.route} page={page} onNavigate={onEnterApp} />
          ))}
          <li>
            <ExternalLink href={GITHUB_URL}>GitHub</ExternalLink>
          </li>
          <li>
            <ExternalLink href={RELEASES_URL}>Releases</ExternalLink>
          </li>
        </FooterColumn>

        <FooterColumn title="Docs">
          {docs.map((page) => (
            <PageItem key={page.route} page={page} onNavigate={onEnterApp} />
          ))}
        </FooterColumn>

        <FooterColumn title="Publishing">
          {publishing.map((page) => (
            <PageItem key={page.route} page={page} onNavigate={onEnterApp} />
          ))}
        </FooterColumn>
      </div>

      <div className="site-column flex flex-wrap items-center justify-between gap-4 pb-10 pt-6 text-[14px] font-medium text-[var(--mk-blush)]">
        <span>© {new Date().getFullYear()} Notefig. All rights reserved</span>
        <span>The AI metaharness.</span>
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

function FooterColumn({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <nav aria-label={title}>
      <p className="text-[15px] font-semibold">{title}</p>
      <ul className="mt-5 space-y-3">{children}</ul>
    </nav>
  );
}

function PageItem({
  page,
  onNavigate,
}: {
  page: MarketingPage;
  onNavigate: () => void;
}) {
  return (
    <li>
      <PageLink page={page} onNavigate={onNavigate} className="mk-footer-link">
        {page.title}
      </PageLink>
    </li>
  );
}
