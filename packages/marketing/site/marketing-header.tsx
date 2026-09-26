import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { DownloadAppLink } from "./download-app-link";
import { GITHUB_URL } from "./links";

export function MarketingHeader({ onEnterApp }: { onEnterApp: () => void }) {
  return (
    <header className="mk mk-header select-text">
      <div className="site-column grid h-full grid-cols-[1fr_auto] items-center gap-6 md:grid-cols-[1fr_auto_1fr]">
        <Link
          to="/"
          className="flex items-center gap-2 text-[21px] font-semibold tracking-[-0.02em]"
        >
          <img src="/icon.svg" alt="" className="size-7" aria-hidden="true" />
          <span>Notefig</span>
        </Link>
        <nav className="hidden items-center gap-8 md:flex">
          <a href="#features" className="mk-nav-link">
            Features
          </a>
          <a href="#agents" className="mk-nav-link">
            Agents
          </a>
          <button type="button" onClick={onEnterApp} className="mk-nav-link">
            Docs
          </button>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener"
            className="mk-nav-link inline-flex items-center gap-0.5"
          >
            GitHub
            <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
          </a>
        </nav>
        <div className="flex justify-end">
          <DownloadAppLink label="Download" className="mk-btn mk-btn-dark" />
        </div>
      </div>
    </header>
  );
}
