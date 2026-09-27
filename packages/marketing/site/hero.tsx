import { ArrowUpRight, ChevronRight, Sparkles } from "lucide-react";
import { DownloadButton } from "./download-app-link";
import { APP_URL, GITHUB_URL } from "./links";
import { Brand } from "./marketing-mocks";

/** The Markdown mark (dcurtis/markdown-mark, public domain), hollow: an
 *  outlined frame around the M and arrow, set at text size in the headline. */
function MarkdownMark() {
  return (
    <svg
      viewBox="0 0 208 128"
      role="img"
      aria-label="Markdown"
      className="inline-block h-[0.72em] w-auto align-[-0.02em]"
    >
      <rect
        x="7"
        y="7"
        width="194"
        height="114"
        rx="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="13"
      />
      <path
        fill="currentColor"
        d="M30 98V30h20l20 25 20-25h20v68H90V59L70 84 50 59v39zm125 0l-30-33h20V30h20v35h20z"
      />
    </svg>
  );
}

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
        Claude Code, Codex and OpenCode in one workspace
      </span>
      <h1 className="mk-display mt-6">
        Put your <MarkdownMark />
        <br />
        to work
      </h1>
      <p className="mk-lede mt-6 max-w-[520px]">
        The open-source AI metaharness. Run all your agents side by side,
        right in your Markdown.
      </p>

      <div className="mt-10 flex items-center justify-center gap-2 sm:gap-3">
        <DownloadButton />
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
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener"
        className="mt-6 inline-flex items-center gap-1.5 text-[14px] font-medium text-[var(--mk-soft)] transition-colors hover:text-[var(--mk-ink)]"
      >
        <Brand name="GitHub" size={14} />
        Open source, MIT licensed
        <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
      </a>
    </section>
  );
}
