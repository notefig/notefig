import { useEffect } from "react";
import type { Value } from "platejs";
import { Plate, usePlateEditor } from "platejs/react";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { BasicNodesKit } from "@/components/editor/plugins/basic-nodes-kit";
import { EditorToolbar } from "@/components/editor-toolbar";
import { Icons } from "@/components/icons";
import { useFileManager } from "@/hooks/useFileManager";

interface FileEditorProps {
  filePath: string;
}

export const FileEditor = ({ filePath }: FileEditorProps) => {
  const {
    currentFile,
    isLoading,
    isSaving,
    isModified,
    hasError,
    setCurrentFile,
    saveCurrentFile,
  } = useFileManager(filePath, {
    autoLoad: true,
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
    value: textToPlateValue(currentFile?.content || ""),
  });

  // Update editor when file content changes
  useEffect(() => {
    if (editor && currentFile?.content !== undefined) {
      const newValue = textToPlateValue(currentFile.content);
      editor.tf.setValue(newValue);
    }
  }, [editor, currentFile?.content]);

  // Handle save shortcut (Ctrl/Cmd + S)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isModified) {
          saveCurrentFile();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isModified, saveCurrentFile]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin">
          <Icons.folder className="h-8 w-8 text-muted-foreground" />
        </div>
        <span className="ml-2 text-muted-foreground">Loading file...</span>
      </div>
    );
  }

  if (hasError) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Icons.alertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Error Loading File</h3>
          <p className="text-sm text-muted-foreground mb-4">
            {currentFile?.error}
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

  return (
    <div className="flex h-full flex-col bg-background">
      <EditorToolbar
        isModified={isModified}
        isSaving={isSaving}
        onSave={saveCurrentFile}
        fileName={filePath.split("/").pop() || "Untitled"}
      />
      <div className="flex-1 h-full overflow-hidden">
        <Plate
          editor={editor}
          onChange={({ value }) => {
            const text = extractTextFromPlateValue(value);
            setCurrentFile(text);
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
