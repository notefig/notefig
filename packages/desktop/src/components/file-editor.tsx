import { useEffect } from "react";
import type { Value } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { BasicNodesKit } from "@/components/editor/plugins/basic-nodes-kit";
import { EditorToolbar } from "@/components/editor-toolbar";
import { Icons } from "@/components/icons";
import { useFileManager } from "@/hooks/useFileManager";

export const FileEditor = () => {
  const {
    activeFile,
    activeFilePath,
    isActiveFileLoading,
    isActiveFileSaving,
    isActiveFileModified,
    hasActiveFileError,
    setActiveFile,
    saveActiveFile,
  } = useFileManager({
    onError: (error) => console.error("File operation failed:", error),
    onSave: (savedPath) => console.log("File saved:", savedPath),
  });

  // Convert Plate value to plain text
  const extractTextFromPlateValue = (value: Value): string => {
    return value
      .map(
        (node: any) =>
          node.children?.map((child: any) => child.text || "").join("") || "",
      )
      .join("\n");
  };

  // Convert plain text to Plate value
  const textToPlateValue = (text: string): Value => {
    return text
      ? [{ type: "p", children: [{ text }] }]
      : [{ type: "p", children: [{ text: "" }] }];
  };

  // Initialize Plate editor
  const editor = usePlateEditor({
    plugins: BasicNodesKit,
    value: textToPlateValue(activeFile?.content || ""),
  });

  // Update editor when active file content changes
  useEffect(() => {
    if (editor && activeFile?.content !== undefined) {
      const newValue = textToPlateValue(activeFile.content);
      editor.tf.setValue(newValue);
    }
  }, [editor, activeFile?.content]);

  // Handle save shortcut (Ctrl/Cmd + S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isActiveFileModified && activeFilePath) {
          saveActiveFile();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isActiveFileModified, activeFilePath, saveActiveFile]);

  if (isActiveFileLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin">
          <Icons.folder className="h-8 w-8 text-muted-foreground" />
        </div>
        <span className="ml-2 text-muted-foreground">Loading file...</span>
      </div>
    );
  }

  if (hasActiveFileError) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Icons.alertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Error Loading File</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {activeFile?.error}
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Show welcome message if no active tab
  if (!activeFilePath) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Icons.folder className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">No File Selected</h3>
          <p className="text-sm text-muted-foreground">
            Select a file from the explorer to start editing
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <EditorToolbar
        isModified={isActiveFileModified}
        isSaving={isActiveFileSaving}
        onSave={saveActiveFile}
        fileName={activeFilePath.split("/").pop() || "Untitled"}
      />
      <div className="flex-1 h-full overflow-hidden">
        <Plate
          editor={editor}
          onChange={({ value }) => {
            const text = extractTextFromPlateValue(value);
            setActiveFile(text);
          }}
        >
          <EditorContainer className="h-full">
            <Editor
              variant="fullWidth"
              className="h-full"
              placeholder="# Start writing..."
            />
          </EditorContainer>
        </Plate>
      </div>
    </div>
  );
};
