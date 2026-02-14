import { useCallback, useRef, useEffect, useState } from "react";
import { Plate, usePlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import { MarkdownEditorKit } from "@/components/editor/markdown-editor-kit";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { MarkToolbarButton } from "@/components/ui/mark-toolbar-button";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { ToolbarButton } from "@/components/ui/toolbar";
import { Separator } from "@/components/ui/separator";
import {
  Code2Icon,
  ListIcon,
  ListOrderedIcon,
  Link2Icon,
  StrikethroughIcon,
} from "lucide-react";
import { toggleList, ListStyleType } from "@platejs/list";
import type { FileEntry } from "../../utils/fs";
import {
  loadFileContent,
  writeFileContent,
  getOrCreateWorkspaceCollections,
} from "@/utils/collections";
import { useLiveQuery, eq } from "@tanstack/react-db";

interface TextEditorProps {
  file: FileEntry;
  basePath: string;
}

/**
 * Loading state component shown while file content is being loaded
 */
function EditorLoading() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-muted-foreground">Loading file content...</div>
    </div>
  );
}

/**
 * The actual editor component - only rendered when content is available
 */
function EditorWithContent({
  file,
  basePath,
  initialContent,
}: {
  file: FileEntry;
  basePath: string;
  initialContent: string;
}) {
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const editor = usePlateEditor({
    plugins: MarkdownEditorKit,
    value: (editor) =>
      editor.getApi(MarkdownPlugin).markdown.deserialize(initialContent),
  });

  const handleChange = useCallback(() => {
    if (!editor) return;

    // Cancel any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce saves by 300ms
    saveTimeoutRef.current = setTimeout(() => {
      const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
      // Normalize: remove HTML entity for space
      const normalizedMarkdown = markdown.replace(/&#x20;/g, "");

      console.log(`[TextEditor] Saving content for: ${file.path}`);
      writeFileContent(basePath, file.path, normalizedMarkdown);
    }, 300);
  }, [editor, file.path, basePath]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return (
    <Plate editor={editor} onValueChange={handleChange}>
      <FixedToolbar className="justify-start rounded-t-lg gap-1 flex-wrap">
        <ToolbarButton
          onClick={() => editor.tf.h1.toggle()}
          tooltip="Heading 1"
        >
          H1
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.tf.h2.toggle()}
          tooltip="Heading 2"
        >
          H2
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.tf.h3.toggle()}
          tooltip="Heading 3"
        >
          H3
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <MarkToolbarButton nodeType="bold" tooltip="Bold (⌘+B)">
          <strong>B</strong>
        </MarkToolbarButton>
        <MarkToolbarButton nodeType="italic" tooltip="Italic (⌘+I)">
          <em>I</em>
        </MarkToolbarButton>
        <MarkToolbarButton nodeType="underline" tooltip="Underline (⌘+U)">
          <span className="underline">U</span>
        </MarkToolbarButton>
        <MarkToolbarButton
          nodeType="strikethrough"
          tooltip="Strikethrough (⌘+Shift+X)"
        >
          <StrikethroughIcon className="h-4 w-4" />
        </MarkToolbarButton>
        <MarkToolbarButton nodeType="code" tooltip="Inline Code (⌘+E)">
          <Code2Icon className="h-4 w-4" />
        </MarkToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <ToolbarButton
          onClick={() =>
            toggleList(editor, { listStyleType: ListStyleType.Disc })
          }
          tooltip="Bullet List"
        >
          <ListIcon className="h-4 w-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={() =>
            toggleList(editor, { listStyleType: ListStyleType.Decimal })
          }
          tooltip="Numbered List"
        >
          <ListOrderedIcon className="h-4 w-4" />
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <ToolbarButton
          onClick={() => editor.tf.blockquote.toggle()}
          tooltip="Blockquote"
        >
          Quote
        </ToolbarButton>
        <ToolbarButton
          onClick={() => editor.tf.codeBlock.toggle()}
          tooltip="Code Block (⌘+Alt+8)"
        >
          {"</>"}
        </ToolbarButton>

        <Separator orientation="vertical" className="h-6" />

        <ToolbarButton
          onClick={() => editor.tf.link.toggle()}
          tooltip="Toggle Link"
        >
          <Link2Icon className="h-4 w-4" />
        </ToolbarButton>
      </FixedToolbar>
      <EditorContainer>
        <Editor placeholder="Type your amazing content here..." />
      </EditorContainer>
    </Plate>
  );
}

/**
 * Main TextEditor component
 * Handles loading file content and rendering the appropriate UI
 */
export function TextEditor({ file, basePath }: TextEditorProps) {
  const [isLoading, setIsLoading] = useState(true);
  const lastLoadedPathRef = useRef<string | null>(null);

  // Get the content collection
  const { content } = getOrCreateWorkspaceCollections(basePath);

  // Query file content reactively
  const { data: fileContentArray = [] } = useLiveQuery((q) =>
    q
      .from({ c: content })
      .where(({ c }) => eq(c.path, file.path))
      .select(({ c }) => ({
        path: c.path,
        content: c.content,
      })),
  );

  // Also check all content items to debug
  const { data: allContentArray = [] } = useLiveQuery((q) =>
    q.from({ c: content }).select(({ c }) => ({ path: c.path })),
  );

  console.log(`[TextEditor] Collection state:`, {
    path: file.path,
    totalItemsInCollection: allContentArray.length,
    allPaths: allContentArray.map((item) => item.path),
  });

  console.log(`[TextEditor] Query result:`, {
    path: file.path,
    arrayLength: fileContentArray.length,
    hasResult: fileContentArray.length > 0,
    firstItem: fileContentArray[0],
  });

  const fileContent = fileContentArray[0]?.content;

  // Load file content when file path changes
  useEffect(() => {
    // When file changes, show loading state
    if (lastLoadedPathRef.current !== file.path) {
      setIsLoading(true);
    }

    // Skip if we already loaded this exact file path
    if (lastLoadedPathRef.current === file.path) {
      console.log(`[TextEditor] Content already loaded for: ${file.path}`);
      return;
    }

    console.log(`[TextEditor] Loading content for: ${file.path}`);

    // Load the content
    loadFileContent(basePath, file.path)
      .then(() => {
        console.log(
          `[TextEditor] Content loaded successfully for: ${file.path}`,
        );
        lastLoadedPathRef.current = file.path;
      })
      .catch((error) => {
        console.error(
          `[TextEditor] Failed to load content for: ${file.path}`,
          error,
        );
        // Even on error, mark as loaded to prevent infinite retries
        lastLoadedPathRef.current = file.path;
        setIsLoading(false);
      });
  }, [basePath, file.path]);

  // When content becomes available, hide loading state
  useEffect(() => {
    console.log(`[TextEditor] Content availability check:`, {
      path: file.path,
      hasContent: fileContent !== undefined,
      isLoading,
      contentLength: fileContent?.length,
    });

    if (fileContent !== undefined) {
      console.log(`[TextEditor] Content available for: ${file.path}`, {
        contentLength: fileContent.length,
        contentPreview: fileContent.substring(0, 50),
      });
      console.log(`[TextEditor] Setting isLoading to false`);
      setIsLoading(false);
    }
  }, [fileContent, file.path, isLoading]);

  // Show loading state while content is being fetched
  console.log(`[TextEditor] Render decision:`, {
    path: file.path,
    isLoading,
    hasContent: fileContent !== undefined,
    willShowLoading: isLoading || fileContent === undefined,
  });

  if (isLoading) {
    return <EditorLoading />;
  }

  // Render the editor with the loaded content
  // Key on file.path to force remount when switching files
  return (
    <EditorWithContent
      key={file.path}
      file={file}
      basePath={basePath}
      initialContent={fileContent}
    />
  );
}
