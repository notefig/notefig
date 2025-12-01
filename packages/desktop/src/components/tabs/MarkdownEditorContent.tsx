import React, { useEffect, useState } from "react";
import { Plate, usePlateEditor } from "platejs/react";
import { MarkdownPlugin } from "@platejs/markdown";
import remarkGfm from "remark-gfm";
import remarkEmoji from "remark-emoji";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import remarkMdx from "remark-mdx";
import { useAtom } from "jotai";
import { fileSystemAtom } from "@/atoms/fileSystem";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { BasicNodesKit } from "@/components/editor/plugins/basic-nodes-kit";
import { EditorToolbar } from "@/components/editor-toolbar";
import { Icons } from "@/components/icons";
import { useFileManager } from "@/hooks/useFileManager";
import { TabContentProps, TabContentWrapper } from "./TabContent";

export const MarkdownEditorContent: React.FC<TabContentProps> = ({
  filePath,
  isActive,
}) => {
  const [fileSystem, setFileSystem] = useAtom(fileSystemAtom);
  const { saveFile } = useFileManager({
    onError: (error) => console.error("File operation failed:", error),
    onSave: (savedPath) => console.log("File saved:", savedPath),
  });

  // Remark plugins configuration
  const remarkPlugins = [
    remarkMath,
    remarkGfm,
    remarkMdx,
    remarkEmoji as any,
    remarkBreaks,
  ];

  // Get file state for this specific tab
  const fileState = fileSystem.files[filePath];
  const fileContent = fileState?.content || "";
  const isLoading = fileState?.state === "loading";
  const isSaving = fileState?.state === "saving";
  const isModified = fileState?.state === "loaded_modified";
  const hasError = fileState?.state === "error";

  // Initialize editor for this specific file
  const editor = usePlateEditor(
    {
      plugins: BasicNodesKit,
      value: [{ type: "p", children: [{ text: "" }] }], // Start with empty content
    },
    [filePath], // Recreate editor when filePath changes
  );

  // Track if this is the initial load to preserve undo history
  const [isInitialLoad, setIsInitialLoad] = useState(true);

  // Update editor content when file content changes
  useEffect(() => {
    if (editor && fileState) {
      try {
        const currentEditorMarkdown = editor
          .getApi(MarkdownPlugin)
          .markdown.serialize();

        // Only update if the content is actually different to prevent unnecessary re-renders
        if (fileContent !== currentEditorMarkdown) {
          const newValue = fileContent
            ? editor.getApi(MarkdownPlugin).markdown.deserialize(fileContent, {
                remarkPlugins,
              })
            : [{ type: "p", children: [{ text: "" }] }];

          if (isInitialLoad) {
            // On initial load, set content without recording in undo history
            editor.tf.reset();
            // Use withoutSaving to prevent this from being recorded in undo history
            editor.tf.withoutSaving(() => {
              editor.tf.setValue(newValue);
            });
            setIsInitialLoad(false);
          } else {
            // For subsequent updates (file changes from disk), preserve history
            // Don't update if user has made local changes - let them handle conflicts
            const isUserModified = fileState.state === "loaded_modified";
            if (!isUserModified) {
              // File changed on disk but user hasn't modified it locally
              // Update content but preserve undo history
              editor.tf.withoutSaving(() => {
                editor.tf.setValue(newValue);
              });
            }
          }
        }
      } catch (error) {
        console.error("Failed to update editor content:", error);
        // On error, set empty content
        const newValue = [{ type: "p", children: [{ text: "" }] }];
        if (isInitialLoad) {
          editor.tf.reset();
          setIsInitialLoad(false);
        }
        // Don't save error recovery in undo history
        editor.tf.withoutSaving(() => {
          editor.tf.setValue(newValue);
        });
      }
    }
  }, [editor, fileContent, fileState, remarkPlugins, isInitialLoad]);

  // Handle save shortcut (Ctrl/Cmd + S) - only for active tab
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isModified && filePath) {
          saveFile(filePath);
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isActive, isModified, filePath, saveFile]);

  // Handle content changes with debouncing for better performance
  const handleContentChange = () => {
    if (!isActive) return; // Only handle changes for active tabs

    try {
      const markdownText = editor.getApi(MarkdownPlugin).markdown.serialize();

      // Update file content in the file system
      if (fileSystem.files[filePath]) {
        const isContentModified =
          markdownText !== fileSystem.files[filePath].originalContent;

        setFileSystem((prev) => ({
          ...prev,
          files: {
            ...prev.files,
            [filePath]: {
              ...prev.files[filePath],
              content: markdownText,
              state: isContentModified ? "loaded_modified" : "loaded",
            },
          },
        }));
      }
    } catch (error) {
      console.error("Failed to serialize markdown:", error);
    }
  };

  if (isLoading) {
    return (
      <TabContentWrapper isActive={isActive} filePath={filePath}>
        <div className="flex items-center justify-center h-full">
          <div className="animate-spin">
            <Icons.folder className="h-8 w-8 text-muted-foreground" />
          </div>
          <span className="ml-2 text-muted-foreground">Loading file...</span>
        </div>
      </TabContentWrapper>
    );
  }

  if (hasError) {
    return (
      <TabContentWrapper isActive={isActive} filePath={filePath}>
        <div className="flex items-center justify-center h-full">
          <div className="text-center">
            <Icons.alertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
            <h3 className="text-lg font-semibold mb-2">Error Loading File</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {fileState?.error}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            >
              Retry
            </button>
          </div>
        </div>
      </TabContentWrapper>
    );
  }

  const fileName = filePath.split("/").pop() || "Untitled";

  return (
    <TabContentWrapper isActive={isActive} filePath={filePath}>
      <EditorToolbar
        isModified={isModified}
        isSaving={isSaving}
        onSave={() => saveFile(filePath)}
        fileName={fileName}
      />
      <div className="flex-1 overflow-hidden">
        <Plate editor={editor} onChange={handleContentChange}>
          <EditorContainer className="h-full">
            <Editor
              variant="fullWidth"
              className="h-full"
              placeholder="# Start writing..."
            />
          </EditorContainer>
        </Plate>
      </div>
    </TabContentWrapper>
  );
};
