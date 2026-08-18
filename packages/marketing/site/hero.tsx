import { findPageByRoute } from "./content-manifest";
import { APP_URL, RELEASES_URL } from "./links";
import { PageLink, PageLinkRow } from "./page-links";

const DOWNLOAD_PAGE = findPageByRoute("/download");

/**
 * The only prose the site keeps outside the app: a short pitch and the two
 * CTAs. Everything else a visitor reads lives in the workspace below, as
 * files they can open, edit and copy.
 */
export function Hero({
  activeRoute,
  onEnterApp,
}: {
  activeRoute?: string;
  onEnterApp: () => void;
}) {
  return (
    // Sized in viewport heights so the app always peeks above the fold: the
    // hero is the promise, the app underneath is the proof.
    <section className="mx-auto flex min-h-[62vh] max-w-5xl flex-col justify-center gap-6 px-6 pb-8 pt-20">
      <h1 className="max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">
        Write markdown.
        <br />
        Continuously publish.
      </h1>
      <p className="max-w-xl text-base text-muted-foreground sm:text-lg">
        Notefig turns plain markdown files into published books and sites. Your
        content stays in files you own — write, commit, and every change ships
        itself.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <a
          href={APP_URL}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Open the web app
        </a>
        {DOWNLOAD_PAGE ? (
          <PageLink
            page={DOWNLOAD_PAGE}
            onNavigate={onEnterApp}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Download for macOS
          </PageLink>
        ) : (
          <a
            href={RELEASES_URL}
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
            rel="noopener"
          >
            Download for macOS
          </a>
        )}
      </div>

      <PageLinkRow activeRoute={activeRoute} onNavigate={onEnterApp} />
    </section>
  );
}
