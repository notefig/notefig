"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  CodeView,
  WorkerPoolContextProvider,
  type CodeViewFileItem,
  type CodeViewHandle,
} from "@pierre/diffs/react";
import DiffsHighlightWorker from "@pierre/diffs/worker/worker.js?worker";
import type { FileEntry } from "@/utils/fs";
import type { SearchTarget } from "@/adapters/platform-adapter.interface";
import {
  consumePendingNavigation,
  getOrCreateEditor,
  registerCodeNavigator,
  unregisterCodeNavigator,
} from "@/components/editor/editor-store";
import { requestTabFocus } from "@/tabs/tab-controllers";
import { useTheme } from "@/components/theme-provider";
import { getFileName } from "@/utils/fs";

interface CodeViewerProps {
  file: FileEntry;
}

/**
 * Injected into the CodeView shadow root's `@layer unsafe` (declared last,
 * so it wins over Pierre's base/theme layers at equal specificity). Two
 * moves that belong together:
 *
 * - The painted surfaces go transparent so the app's own background (and
 *   its texture) shows through the viewer.
 * - `--diffs-bg` is re-pointed at the app's background token — custom
 *   properties inherit across the shadow boundary, and `--background`
 *   flips with the `.dark` class like everywhere else. Pierre derives its
 *   whole palette (gutter fg, hover, context, selection tints) by
 *   color-mixing against `--diffs-bg`, so it must stay a real color that
 *   matches what's actually behind the text; leaving it at Pierre's
 *   #fff/#000 would skew every derived tint, and making it `transparent`
 *   would poison the mixes outright.
 */
const TRANSPARENT_BACKGROUND_CSS = `
:host {
  --diffs-light-bg: hsl(var(--background));
  --diffs-dark-bg: hsl(var(--background));
}
:host, pre, code,
[data-content-buffer], [data-gutter-buffer] {
  background-color: transparent;
}
`;

/**
 * Locate a SearchTarget in the raw file text. Unlike the markdown editor —
 * which renders a parsed document and has to re-locate matches fuzzily
 * (editor-position.ts) — the code viewer displays the file's exact bytes,
 * so the target's occurrence index maps directly: the Nth case-sensitive
 * occurrence of matchText in the content is the match. Returns the
 * 1-indexed line number, or undefined when the content has changed enough
 * that the occurrence no longer exists.
 */
function lineNumberForTarget(
  content: string,
  target: SearchTarget,
): number | undefined {
  if (!target.matchText) return undefined;
  let index = -1;
  for (let i = 0; i <= target.occurrence; i++) {
    index = content.indexOf(target.matchText, index + 1);
    if (index === -1) return undefined;
  }
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Read-only code viewer built on @pierre/diffs (MET-147). Renders any text
 * file that isn't markdown-editable with syntax highlighting (language
 * inferred from the filename), virtualized scrolling, line numbers and
 * line selection. Uses the same CodeView infrastructure Pierre's diffs
 * render with, so a future diff surface shares this code path.
 *
 * Registered in the editor store as a container instance ("code"), which
 * gives it tab focus, dispose and find-in-tab through the generic tab
 * controller like every other tab.
 */
export function CodeViewer({ file }: CodeViewerProps) {
  const { theme } = useTheme();
  const handleRef = useRef<CodeViewHandle<undefined>>(null);

  useEffect(() => {
    getOrCreateEditor(file.path, { type: "code" });
  }, [file.path]);

  // Mount focus goes through the arbiter like the text editor's, so it
  // competes with modals, the sidebar and other tabs on the same terms
  // instead of a raw rAF grab. The controller registered above resolves it.
  useEffect(() => {
    requestTabFocus(file.path, {
      when: "next-frame",
      reason: "code-viewer-mount",
    });
  }, [file.path]);

  const content = file.content ?? "";
  const contentRef = useRef(content);
  contentRef.current = content;

  // Publish match navigation for the container instance's goToLocation and
  // consume a navigation intent that was waiting for this mount (a search
  // panel click that opened the tab).
  useEffect(() => {
    const reveal = (target: SearchTarget): boolean => {
      const handle = handleRef.current;
      if (!handle) return false;
      const lineNumber = lineNumberForTarget(contentRef.current, target);
      if (lineNumber === undefined) return false;
      handle.scrollTo({
        type: "line",
        id: file.path,
        lineNumber,
        align: "center",
      });
      handle.setSelectedLines({
        id: file.path,
        range: { start: lineNumber, end: lineNumber },
      });
      return true;
    };
    registerCodeNavigator(file.path, reveal);
    const pending = consumePendingNavigation(file.path);
    if (pending) {
      // The CodeView mounts alongside this effect; give it a frame to lay
      // out before scrolling.
      requestAnimationFrame(() => reveal(pending));
    }
    return () => unregisterCodeNavigator(file.path);
  }, [file.path]);

  // CodeView applies a controlled item update only when its `version`
  // moves (a changed cacheKey alone is not enough), so every recompute —
  // i.e. every content change, including external edits picked up by the
  // watcher — bumps it.
  const versionRef = useRef(0);
  const items = useMemo<CodeViewFileItem[]>(
    () => [
      {
        id: file.path,
        type: "file",
        version: ++versionRef.current,
        file: {
          name: getFileName(file.path),
          contents: content,
          cacheKey: `${file.path}:${file.contentHash}`,
        },
      },
    ],
    [file.path, content, file.contentHash],
  );

  const options = useMemo(
    () => ({
      // The dockable tab already names the file; Pierre's own header would
      // repeat it.
      disableFileHeader: true,
      themeType: theme,
      unsafeCSS: TRANSPARENT_BACKGROUND_CSS,
    }),
    [theme],
  );

  return (
    <div
      data-editor-container={file.path}
      // select-text: the app's universal user-select:none reaches the
      // shadow tree through the host (its contents are `auto`), so the
      // subtree opt-in here is what makes the rendered code selectable.
      // Pierre keeps its own gutters/line numbers `none`, so copies stay
      // free of line numbers, and the body[data-dockable-dragging] guard
      // still wins during tab drags.
      // bg-background + texture-surface: the CodeView layers are
      // transparent (see TRANSPARENT_BACKGROUND_CSS), so this container
      // paints the app background with its grain — same surface treatment
      // as the rest of the app, independent of what sits behind the tab.
      className="select-text bg-background texture-surface flex flex-col flex-1 min-h-0 w-full"
      tabIndex={-1}
    >
      <WorkerPoolContextProvider
        poolOptions={{
          workerFactory: () => new DiffsHighlightWorker(),
          poolSize: 2,
        }}
        highlighterOptions={{}}
      >
        <CodeView
          ref={handleRef}
          items={items}
          options={options}
          className="flex-1 min-h-0"
        />
      </WorkerPoolContextProvider>
    </div>
  );
}
