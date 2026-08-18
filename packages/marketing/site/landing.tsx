import { Link } from "react-router-dom";
import { marketingDocs } from "./content-manifest";
import { usePrerenderHandoff } from "./prerender";

/**
 * Bespoke landing route — shares the app's design tokens but is not forced
 * into the workspace/tab model. The footer links every docs page so crawlers
 * can discover the whole docs tree from `/`.
 */
export function Landing() {
  usePrerenderHandoff(null);

  return (
    <main
      data-marketing-landing
      className="flex-1 overflow-y-auto bg-background"
    >
      <section className="mx-auto flex max-w-3xl flex-col items-center gap-6 px-6 pb-16 pt-24 text-center">
        <img src="/icon.svg" alt="" className="size-14" aria-hidden="true" />
        <h1 className="text-4xl font-semibold tracking-tight">
          Write Markdown.
          <br />
          Continuously publish.
        </h1>
        <p className="max-w-xl text-lg text-muted-foreground">
          Notefig turns plain markdown files into published books and sites.
          Your content stays in files you own — no proprietary formats, no
          lock-in. Write, commit, and every change ships itself.
        </p>
        <div className="flex items-center gap-3">
          <Link
            to="/docs"
            className="rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground hover:opacity-90"
          >
            Start writing
          </Link>
          <a
            href="https://github.com/notefig/notefig/releases"
            className="rounded-md border border-border px-4 py-2 font-medium hover:bg-accent"
          >
            Download for macOS
          </a>
        </div>
        <p className="text-sm text-muted-foreground">
          The docs on this site run inside the real editor — open a page and
          start typing.
        </p>
      </section>

      <section className="mx-auto grid max-w-4xl gap-6 px-6 pb-20 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-5">
          <h2 className="mb-1.5 font-medium">Simplicity</h2>
          <p className="text-sm text-muted-foreground">
            Plain markdown files, a real editor, and a CLI. Everything else is
            automation you set up once.
          </p>
        </div>
        <div className="rounded-lg border border-border p-5">
          <h2 className="mb-1.5 font-medium">Incremental</h2>
          <p className="text-sm text-muted-foreground">
            Publish chapters as you write them. Update after release. Git
            tracks every change.
          </p>
        </div>
        <div className="rounded-lg border border-border p-5">
          <h2 className="mb-1.5 font-medium">Yours</h2>
          <p className="text-sm text-muted-foreground">
            Host anywhere — Vercel, Netlify, S3, or your own server. The
            output is static files.
          </p>
        </div>
      </section>

      <footer className="border-t border-border">
        <nav
          aria-label="Documentation"
          className="mx-auto grid max-w-4xl gap-x-6 gap-y-1.5 px-6 py-10 text-sm sm:grid-cols-3"
        >
          {marketingDocs.map((doc) => (
            <Link
              key={doc.slug}
              to={`/docs/${doc.slug}`}
              className="text-muted-foreground hover:text-foreground"
            >
              {doc.title}
            </Link>
          ))}
        </nav>
      </footer>
    </main>
  );
}
