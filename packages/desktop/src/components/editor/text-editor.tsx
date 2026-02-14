import { useCallback, useRef, useEffect } from "react";
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

export function TextEditor({ file, basePath }: TextEditorProps) {
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastLoadedPathRef = useRef<string | null>(null);
  const contentLoadedRef = useRef<boolean>(false);

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

  const fileContent = fileContentArray[0]?.content;

  // Load file content when file path changes
  useEffect(() => {
    // Reset content loaded flag when file changes
    if (lastLoadedPathRef.current !== file.path) {
      contentLoadedRef.current = false;
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
      });
  }, [basePath, file.path]);

  const editor = usePlateEditor({
    plugins: MarkdownEditorKit,
    value: (editor) =>
      editor
        .getApi(MarkdownPlugin)
        .markdown.deserialize(fileContent || "Loading..."),
  });

  // Update editor value when file content changes
  useEffect(() => {
    if (editor && fileContent !== undefined) {
      const currentMarkdown = editor
        .getApi(MarkdownPlugin)
        .markdown.serialize();
      const normalizedCurrent = currentMarkdown.replace(/\&\#x20\;/, "");

      console.log(`[TextEditor] Content changed:`, {
        path: file.path,
        currentLength: normalizedCurrent.length,
        newLength: fileContent.length,
        currentPreview: normalizedCurrent.substring(0, 50),
        newPreview: fileContent.substring(0, 50),
      });

      // Only update if content actually changed to avoid infinite loops
      if (normalizedCurrent !== fileContent) {
        console.log(`[TextEditor] Updating editor value for: ${file.path}`);
        const newValue = editor
          .getApi(MarkdownPlugin)
          .markdown.deserialize(fileContent);

        // Use Plate's setValue API to properly update editor state
        editor.tf.setValue(newValue);

        // Mark content as loaded so we can start saving changes
        contentLoadedRef.current = true;
      }
    }
  }, [editor, fileContent, file.path]);

  const handleChange = useCallback(() => {
    if (!editor) return;

    // Don't save until initial content is loaded
    if (!contentLoadedRef.current) {
      console.log(
        `[TextEditor] Skipping save - content not loaded yet for: ${file.path}`,
      );
      return;
    }

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
      const normalizedMarkdown = markdown.replace(/\&\#x20\;/, "");

      console.log(`[TextEditor] Saving content for: ${file.path}`);
      // Write content using TanStack DB mutation
      writeFileContent(basePath, file.path, normalizedMarkdown);
    }, 300);
  }, [editor, file.path, basePath]);

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
