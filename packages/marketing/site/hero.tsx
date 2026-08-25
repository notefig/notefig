import { DownloadAppLink } from "./download-app-link";
import { APP_URL } from "./links";

/**
 * Short pitch and the two CTAs. The live app sits under this as a product
 * window; the longer story is in MarketingSections below it.
 */
export function Hero() {
  return (
    <section className="site-column flex flex-col items-center gap-5 pb-10 pt-24 text-center">
      <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">
        Write markdown.
        <br />
        Continuously publish.
      </h1>
      <p className="max-w-lg text-sm text-muted-foreground sm:text-base">
        Notefig turns a folder of markdown into a published docs site. Your
        team writes, commits, and every change can ship itself.
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <a
          href={APP_URL}
          target="_blank"
          rel="noopener"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Open the web app
        </a>
        <DownloadAppLink className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent" />
      </div>
    </section>
  );
}
