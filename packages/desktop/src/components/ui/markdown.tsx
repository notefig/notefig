import { useEffect, useRef, useState } from "react";
import { renderMarkdown } from "@/utils/markdown-conversion";
import { platformAdapter } from "@/adapters";
import { cn } from "@notefig/ui/utils";

/**
 * Rendered-HTML cache keyed by source text: completed messages render
 * synchronously on remount (tab switches, transcript re-renders) with no
 * plain-text flash. Streaming fills it with prefixes of the growing message,
 * hence the LRU cap.
 *
 * 2000, not a few hundred: a single long streaming reply mints hundreds of
 * prefix keys, and under the virtualized transcript (MET-149) scrolling
 * through history REMOUNTS messages — every eviction there costs a worker
 * round-trip mid-scroll plus a visible plain-text flash. Entries are strings
 * of rendered HTML; even a full cache is a few MB.
 */
const HTML_CACHE_MAX = 2000;
const htmlCache = new Map<string, string>();

function cacheGet(text: string): string | undefined {
  const html = htmlCache.get(text);
  if (html !== undefined) {
    htmlCache.delete(text);
    htmlCache.set(text, html);
  }
  return html;
}

function cachePut(text: string, html: string): void {
  htmlCache.delete(text);
  htmlCache.set(text, html);
  if (htmlCache.size > HTML_CACHE_MAX) {
    htmlCache.delete(htmlCache.keys().next().value as string);
  }
}

/**
 * Markdown → HTML through the conversion worker, the same off-thread path
 * the editor uses for parse/serialize (MET-136 — rendering on the main
 * thread re-parsed the whole growing message per stream chunk). The last
 * resolved HTML stays up while a newer render is in flight — latest-wins
 * coalescing, so streaming never piles up requests.
 */
function useMarkdownHtml(text: string): string | null {
  const [rendered, setRendered] = useState<{
    text: string;
    html: string;
  } | null>(() => {
    const html = cacheGet(text);
    return html === undefined ? null : { text, html };
  });
  const state = useRef({ latest: text, inFlight: false, mounted: true });
  state.current.latest = text;

  useEffect(() => {
    const s = state.current;
    s.mounted = true;
    const request = (source: string) => {
      s.inFlight = true;
      renderMarkdown(source).then(
        (html) => {
          cachePut(source, html);
          s.inFlight = false;
          if (!s.mounted) return;
          setRendered({ text: source, html });
          if (s.latest !== source) request(s.latest);
        },
        (error) => {
          s.inFlight = false;
          console.error("[markdown] render failed:", error);
        },
      );
    };
    const cached = cacheGet(text);
    if (cached !== undefined) {
      setRendered({ text, html: cached });
    } else if (!s.inFlight) {
      request(text);
    }
    return () => {
      s.mounted = false;
    };
  }, [text]);

  return rendered?.html ?? null;
}

/**
 * Renders LLM output as markdown, styled through the typography plugin under
 * its own `rendered` namespace (styles.css) rather than `prose`: the plugin
 * bakes `not-prose` into every prose selector, and the prompt widget is
 * `not-prose` chrome, so a `prose` body inside it lost all typography. The
 * plugin keeps the `--tw-prose-*` variable names, so the overrides pin
 * text to currentColor so the component inherits whatever color its call
 * site sets (foreground in chat, amber for widget issue text) instead of
 * the plugin's gray scale. One delegated click listener routes links out
 * through the platform opener — an in-app anchor would navigate the webview.
 */
export function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const html = useMarkdownHtml(text);
  return (
    <div
      className={cn(
        "rendered rendered-sm dark:rendered-invert max-w-none break-words",
        // WebKit's UA sheet gives editable content `line-break:
        // after-white-space`, and a widget-hosted render inherits it from the
        // ProseMirror contenteditable. In that mode a line's trailing space
        // hangs past the box and counts as scrollable overflow, so a
        // scrolling response body (DoneState's overflow-y-auto) grew a
        // horizontal scrollbar. Rendered output is never edited: normal
        // line breaking, whatever the host.
        "[line-break:auto]",
        "[--tw-prose-body:currentColor] [--tw-prose-headings:currentColor]",
        "[--tw-prose-bold:currentColor] [--tw-prose-code:currentColor]",
        "rendered-pre:whitespace-pre-wrap rendered-pre:break-all",
        // Chat-density spacing: the plugin's default vertical margins are
        // sized for long-form prose and read as gaps between chat lines.
        "rendered-p:my-1 rendered-ul:my-1 rendered-ol:my-1 rendered-li:my-0",
        "rendered-headings:mb-1 rendered-headings:mt-2.5",
        "rendered-pre:my-1.5 rendered-blockquote:my-1.5 rendered-hr:my-2",
        "rendered-table:my-1.5",
        className,
      )}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor?.href) return;
        event.preventDefault();
        platformAdapter.ui.openExternal(anchor.href);
      }}
      dangerouslySetInnerHTML={{ __html: html ?? "" }}
    />
  );
}
