import { ChevronRight, Globe, Sparkles } from "lucide-react";
import { DownloadAppLink } from "./download-app-link";
import { APP_URL } from "./links";
import { Brand } from "./marketing-mocks";

/**
 * Short pitch and the two CTAs — download first, the web app second. The
 * live app sits under this as a product window; the longer story is in
 * MarketingSections below it.
 */
export function Hero() {
  return (
    <section className="site-column flex flex-col items-center pb-16 pt-[80px] text-center">
      <span className="mk-badge">
        <Sparkles size={14} strokeWidth={2} aria-hidden="true" />
        Claude Code, Codex and Cursor in one workspace
      </span>
      <h1 className="mk-display mt-6">
        Make your md files
        <br />
        work for you
      </h1>
      <p className="mk-lede mt-6 max-w-[520px]">
        The AI metaharness. Run all your agents side by side, right in your
        documents.
      </p>

      <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
        <DownloadAppLink className="mk-btn mk-btn-dark" />
        <a
          href={APP_URL}
          target="_blank"
          rel="noopener"
          className="mk-btn mk-btn-link"
        >
          Open the web app
          <ChevronRight size={16} strokeWidth={2.25} aria-hidden="true" />
        </a>
      </div>
      <p className="mt-5 flex items-center gap-3 text-[13px] font-medium text-[var(--mk-muted)]">
        <span className="inline-flex items-center gap-1.5">
          <Brand name="Apple" size={13} /> macOS
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Brand name="Windows" size={12} /> Windows
        </span>
        <a
          href={APP_URL}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1.5 transition-colors hover:text-[var(--mk-ink)]"
        >
          <Globe size={13} strokeWidth={2} aria-hidden="true" /> Web
        </a>
      </p>
    </section>
  );
}
