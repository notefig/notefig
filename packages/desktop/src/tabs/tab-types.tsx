/**
 * Tab types — the render registry. One entry per `TabKind` says what a tab
 * of that kind is called and what goes inside it; `useTabElements` turns the
 * open tab ids into `<Dockable.Tab>` elements from those entries.
 *
 * The pairing with `tab-controllers.ts` is deliberate: that module is what a
 * tab type exposes to the app, this one is what it shows. Adding a tab type
 * means an id scheme (`tab-id.ts`), a controller, and an entry here — no
 * edits to the workspace shell, the hotkeys, or the focus layer.
 */
import { useMemo, useRef, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Dockable } from "@/components/dockable";
import type { TabProps } from "@/components/dockable";
import { AgentChatTab } from "@/components/agent/agent-chat-tab";
import { ReleaseNotesTab } from "@/components/release-notes-tab";
import { PolymorphicEditor } from "@/components/editor/polymorphic-editor";
import type { OpenFileRow } from "@/entities/files";
import type { AgentTaskRow } from "@/entities/agents";
import type { FileEntry } from "@/utils/fs";
import { scratchpadTabTitle } from "@/entities/scratchpads";
import { getFileName } from "@/utils/fs";
import { latestReleaseTitle } from "@/utils/release-notes";
import { parseTabId, type TabKind, type TabRef } from "./tab-id";

/** Everything the open tabs need in order to render, gathered once. */
export interface TabRenderContext {
  workspacePath: string;
  /** Metadata ⋈ content rows for the open file tabs. */
  fileRows: OpenFileRow[];
  /** Task rows for the open agent tabs. */
  agentTaskRows: AgentTaskRow[];
  closeTab: (tabId: string) => void;
}

/** The render context plus what the registry resolves for itself. */
interface ResolvedTabRenderContext extends TabRenderContext {
  /** Version-stamped title of the bundled release notes. */
  releaseNotesTitle: string;
}

/**
 * A tab ready to render. `deps` is what the built element depends on: while
 * those values are unchanged the element is reused as-is, so an unrelated
 * tab's data churn can't re-render this one.
 */
interface BuiltTab {
  name: string;
  content: ReactNode;
  deps: unknown[];
}

interface TabTypeDefinition<K extends TabKind> {
  /** null when the tab's backing row isn't loaded (or is gone): renders
   *  nothing this pass — `useWorkspaceTabs` prunes ids that stay missing. */
  build(
    ref: Extract<TabRef, { kind: K }>,
    context: ResolvedTabRenderContext,
  ): BuiltTab | null;
}

const fileTab: TabTypeDefinition<"file"> = {
  build(ref, { fileRows, workspacePath }) {
    const row = fileRows.find((candidate) => candidate.path === ref.path);
    if (!row) return null;

    return {
      name: scratchpadTabTitle(workspacePath, row) ?? getFileName(row.path),
      deps: [row, workspacePath],
      content: (
        <PolymorphicEditor
          file={row as FileEntry}
          basePath={workspacePath}
          isContentLoaded={row.isContentLoaded}
          contentError={row.contentError}
        />
      ),
    };
  },
};

const agentTab: TabTypeDefinition<"agent"> = {
  build(ref, { agentTaskRows }) {
    const task = agentTaskRows.find(
      (candidate) => candidate.taskId === ref.taskId,
    );
    if (!task) return null;

    return {
      // Session titles are first-prompt text (up to 60 chars) — far wider
      // than file names, so give tabs a much shorter ellipsis.
      name:
        task.title.length > 24
          ? `${task.title.slice(0, 23).trimEnd()}…`
          : task.title,
      // Only the title is read here; the tab subscribes to everything else
      // about the session itself.
      deps: [ref.taskId, task.title],
      content: <AgentChatTab taskId={ref.taskId} />,
    };
  },
};

const releaseNotesTab: TabTypeDefinition<"release-notes"> = {
  build(_ref, { releaseNotesTitle }) {
    return {
      name: releaseNotesTitle,
      deps: [releaseNotesTitle],
      content: <ReleaseNotesTab />,
    };
  },
};

const TAB_TYPES: { [K in TabKind]: TabTypeDefinition<K> } = {
  file: fileTab,
  agent: agentTab,
  "release-notes": releaseNotesTab,
};

function buildTab(
  tabId: string,
  context: ResolvedTabRenderContext,
): BuiltTab | null {
  const ref = parseTabId(tabId);
  switch (ref.kind) {
    case "file":
      return TAB_TYPES.file.build(ref, context);
    case "agent":
      return TAB_TYPES.agent.build(ref, context);
    case "release-notes":
      return TAB_TYPES["release-notes"].build(ref, context);
  }
}

function sameDeps(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/**
 * The open tab ids, rendered. Elements are cached per tab id and only
 * rebuilt when that tab's own `deps` change: React then bails out of
 * re-rendering the tabs that didn't change, which matters because a
 * streaming agent session and a typing-driven document row both update
 * many times a second.
 */
export function useTabElements(
  openTabs: string[],
  context: TabRenderContext,
): ReactElement<TabProps>[] {
  const cache = useRef(
    new Map<string, { deps: unknown[]; element: ReactElement<TabProps> }>(),
  );
  const { t } = useTranslation();
  const releaseNotesTitle = latestReleaseTitle ?? t("releaseNotesTitle");
  const { workspacePath, fileRows, agentTaskRows, closeTab } = context;

  return useMemo(() => {
    const resolved: ResolvedTabRenderContext = {
      workspacePath,
      fileRows,
      agentTaskRows,
      releaseNotesTitle,
      closeTab,
    };
    const next = new Map<
      string,
      { deps: unknown[]; element: ReactElement<TabProps> }
    >();
    const elements: ReactElement<TabProps>[] = [];

    for (const tabId of openTabs) {
      const built = buildTab(tabId, resolved);
      if (!built) continue;

      const deps = [...built.deps, built.name, closeTab];
      const cached = cache.current.get(tabId);
      const element =
        cached && sameDeps(cached.deps, deps)
          ? cached.element
          : ((
              <Dockable.Tab
                key={tabId}
                id={tabId}
                name={built.name}
                // closeTab is a functional layout update rather than a
                // closure over `layout`, so this element stays stable
                // across tab selects and drags.
                onClose={() => closeTab(tabId)}
              >
                {built.content}
              </Dockable.Tab>
            ) as ReactElement<TabProps>);

      next.set(tabId, { deps, element });
      elements.push(element);
    }

    cache.current = next;
    return elements;
  }, [
    openTabs,
    workspacePath,
    fileRows,
    agentTaskRows,
    releaseNotesTitle,
    closeTab,
  ]);
}
