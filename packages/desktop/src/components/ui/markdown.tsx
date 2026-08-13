import { useMemo } from "react";
import MarkdownIt from "markdown-it";
import { platformAdapter } from "@/adapters";
import { cn } from "@/lib/utils";

// html: false keeps raw HTML in model output escaped (rendered as text), so
// no sanitizer pass is needed; breaks matches the chat's old pre-wrap feel
// where a single newline was a visible line break.
const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

/**
 * Renders LLM output as markdown, styled through the same typography-plugin
 * prose classes the release-notes tab uses. The --tw-prose-* overrides pin
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
  const html = useMemo(() => md.render(text), [text]);
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none break-words",
        "[--tw-prose-body:currentColor] [--tw-prose-headings:currentColor]",
        "[--tw-prose-bold:currentColor] [--tw-prose-code:currentColor]",
        "prose-pre:whitespace-pre-wrap prose-pre:break-all",
        // Chat-density spacing: the plugin's default vertical margins are
        // sized for long-form prose and read as gaps between chat lines.
        "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0",
        "prose-headings:mb-1 prose-headings:mt-2.5",
        "prose-pre:my-1.5 prose-blockquote:my-1.5 prose-hr:my-2",
        "prose-table:my-1.5",
        className,
      )}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor?.href) return;
        event.preventDefault();
        platformAdapter.ui.openExternal(anchor.href);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
