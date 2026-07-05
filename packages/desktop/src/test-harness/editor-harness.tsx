/**
 * Dev-only editor harness (route: /__harness/editor).
 *
 * Mounts the real TextEditor (and SearchPanel) against the real platform
 * adapter WITHOUT booting the workspace: no router-driven collections, no
 * file tree, no dockable layout, no IndexedDB seeding ceremony. This is
 * the cheap, focused way to test the markdown editing experience —
 * typing, input rules, autosave, image paste/drop, search — in a real
 * browser (see tests/editor/*.spec.ts).
 *
 * A test configures it before load via:
 *   window.__EDITOR_HARNESS__ = {
 *     basePath?: string;                       // default "/harness-ws"
 *     filePath?: string;                       // default `${basePath}/doc.md`
 *     content?: string;                        // initial document markdown
 *     files?: { path: string; content: string }[]; // extra files (search)
 *   }
 *
 * and observes it via:
 *   window.__HARNESS__ = {
 *     getMarkdown(): string | null;            // current doc serialization
 *     readFile(path): Promise<string | null>;  // adapter-side content
 *     opened: OpenFileInLayoutOptions[];       // recorded openFile calls
 *     selectAll(): void;                       // focus + select the whole doc
 *   }
 */

import { useEffect, useMemo, useState } from "react";
import type { JSONContent } from "@tiptap/core";
import { TextEditor } from "@/components/editor/text-editor";
import { SearchPanel } from "@/components/editor/search-panel";
import { WorkspaceTabsProvider } from "@/components/workspace-tabs-provider";
import {
  getMarkdownEditor,
  disposeAllEditors,
} from "@/components/editor/editor-store";
import { getEditorMarkdown } from "@/components/editor/use-editor-file-sync";
import { platformAdapter } from "@/adapters";
import { openDocument } from "@/utils/markdown-conversion";
import { calculateContentHash } from "@/utils/hash";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";
import type { FileEntry } from "@/utils/fs";

interface HarnessConfig {
  basePath?: string;
  filePath?: string;
  content?: string;
  files?: { path: string; content: string }[];
}

const DEFAULT_CONTENT = "# Harness Doc\n\nHello from the harness.\n";

export function EditorHarness() {
  const config = useMemo<Required<Omit<HarnessConfig, "files">> & HarnessConfig>(
    () => {
      const raw =
        ((window as unknown as Record<string, unknown>).__EDITOR_HARNESS__ as
          | HarnessConfig
          | undefined) ?? {};
      const basePath = raw.basePath ?? "/harness-ws";
      return {
        ...raw,
        basePath,
        filePath: raw.filePath ?? `${basePath}/doc.md`,
        content: raw.content ?? DEFAULT_CONTENT,
      };
    },
    [],
  );

  const [initialDoc, setInitialDoc] = useState<JSONContent | null>(null);
  const [opened] = useState<OpenFileInLayoutOptions[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Seed the doc + any extra files through the adapter so autosave,
      // image assets and search all operate on a consistent store.
      await platformAdapter.writeFiles([
        { path: config.filePath, content: config.content },
        ...(config.files ?? []),
      ]);
      // Editors accept only parsed doc JSON — same worker path as the app.
      const doc = await openDocument(config.filePath, config.content);
      if (!cancelled) setInitialDoc(doc);
    })();
    return () => {
      cancelled = true;
      disposeAllEditors();
    };
  }, [config]);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__HARNESS__ = {
      getMarkdown: () => {
        const editor = getMarkdownEditor(config.filePath);
        return editor ? getEditorMarkdown(editor) : null;
      },
      readFile: async (path: string) => {
        const result = await platformAdapter.readFiles([path]);
        return result.succeeded[0]?.content ?? null;
      },
      opened,
      // Selection set through the editor itself — browser-driven selection
      // (keyboard/mouse) reaches ProseMirror asynchronously via
      // selectionchange, which races with synchronously dispatched events.
      selectAll: () => {
        getMarkdownEditor(config.filePath)?.chain().focus().selectAll().run();
      },
    };
  }, [config, opened]);

  if (!initialDoc) return <div data-testid="harness-loading">loading…</div>;

  const file: FileEntry = {
    path: config.filePath,
    type: "file",
    content: config.content,
    contentHash: calculateContentHash(config.content),
  };

  return (
    <WorkspaceTabsProvider
      openFile={(options) => {
        opened.push(options);
        return true;
      }}
    >
      <div
        className="flex h-screen w-screen text-foreground"
        data-testid="editor-harness"
      >
        <div className="w-72 shrink-0 border-r border-border bg-sidebar">
          <SearchPanel workspacePath={config.basePath} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <TextEditor
            file={file}
            basePath={config.basePath}
            isContentLoaded
            initialDoc={initialDoc}
          />
        </div>
      </div>
    </WorkspaceTabsProvider>
  );
}
