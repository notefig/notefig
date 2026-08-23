import type { LucideIcon } from "lucide-react";
import {
  ArrowUpFromLine,
  Cloud,
  Eye,
  FilePenLine,
  FileText,
  GitBranch,
  Layers,
  Palette,
  RefreshCw,
} from "lucide-react";
import { CliTerminal } from "./cli-terminal";
import { APP_URL, MACOS_DOWNLOAD_URL } from "./links";

const FEATURES: { title: string; body: string; icon: LucideIcon }[] = [
  {
    title: "Markdown editor",
    body: "Syntax highlighting, live preview, and split-screen. Images, tables, code blocks, and math — written as files on disk.",
    icon: FilePenLine,
  },
  {
    title: "Files you own",
    body: "Plain markdown, no proprietary format, no lock-in. Your content stays portable no matter what you publish it as.",
    icon: FileText,
  },
  {
    title: "Git is the source of truth",
    body: "Connect GitHub, GitLab, or your own remote. The editor commits and syncs so the repo is always the docs.",
    icon: GitBranch,
  },
  {
    title: "Publish as you write",
    body: "Ship docs incrementally. Update after release. Content evolves; the published site follows the files.",
    icon: ArrowUpFromLine,
  },
  {
    title: "One-click hosts",
    body: "Deploy to Vercel, Netlify, Railway, Coolify, or S3 from the editor. Notefig writes the host config, including vercel.json.",
    icon: Cloud,
  },
  {
    title: "Many projects, one app",
    body: "Create and switch between projects. Each project has its own git repository and publishing configuration.",
    icon: Layers,
  },
  {
    title: "Live preview",
    body: "Watch a folder of markdown and see the site as you write — in the editor or with the CLI dev server.",
    icon: Eye,
  },
  {
    title: "Deploy on push",
    body: "Connect the GitHub repo to Vercel (or Netlify) and every push rebuilds the docs. Set the workflow up once.",
    icon: RefreshCw,
  },
  {
    title: "Theming",
    body: "The CLI builds a static site with a theme you choose. Override theme and output per project or per command.",
    icon: Palette,
  },
];

/**
 * Marketing beats below the product window. Teams shipping product docs
 * first; the CLI is a second, shorter strip for developers.
 * No social proof — we don't have client logos or quotes yet.
 */
export function MarketingSections() {
  return (
    <div className="site-column flex min-w-0 flex-col gap-24 py-24">
      <section className="flex flex-col gap-12">
        <div className="flex flex-col gap-4">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            One folder of files. A live docs site.
          </h2>
          <p className="max-w-xl text-base text-muted-foreground">
            Teams write product docs in markdown. Notefig turns that folder into
            a published docs site — and keeps shipping as the docs change.
          </p>
        </div>

        <div className="feature-grid">
          {FEATURES.map((feature) => (
            <Beat key={feature.title} {...feature} />
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-5 border-t border-border/60 pt-16">
        <p className="site-kicker text-xs font-medium uppercase tracking-[0.16em]">
          For developers
        </p>
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Same publish path from the CLI.
        </h2>
        <p className="max-w-xl text-base text-muted-foreground">
          Watch a folder, build static files, deploy. Drop it in GitHub
          Actions the same way you run it locally.
        </p>
        <CliTerminal />
      </section>

      <section className="flex flex-col items-start gap-5 border-t border-border/60 pt-16">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Start in the browser, or download for macOS.
        </h2>
        <p className="max-w-xl text-base text-muted-foreground">
          The web app is the same editor. The desktop app talks to folders on
          your machine. Windows and Linux desktop are on the way.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <a
            href={APP_URL}
            target="_blank"
            rel="noopener"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Open the web app
          </a>
          <a
            href={MACOS_DOWNLOAD_URL}
            download
            className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Download for macOS
          </a>
        </div>
      </section>
    </div>
  );
}

function Beat({
  title,
  body,
  icon: Icon,
}: {
  title: string;
  body: string;
  icon: LucideIcon;
}) {
  return (
    <article className="feature-cell">
      <div className="feature-cell-mark" aria-hidden="true">
        <Icon size={15} strokeWidth={1.75} />
      </div>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}
