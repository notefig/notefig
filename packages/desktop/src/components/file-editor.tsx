import { useParams } from "react-router";
import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { fileUrlAtom } from "@/atoms";
import { Plate, usePlateEditor } from "platejs/react";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { BasicNodesKit } from "@/components/editor/plugins/basic-nodes-kit";
import { EditorToolbar } from "@/components/editor-toolbar";
import { ScrollArea } from "@/components/ui/scroll-area";

export function FileEditor() {
  const { "*": filePath } = useParams();
  const setFileUrl = useSetAtom(fileUrlAtom);

  const editor = usePlateEditor({
    plugins: BasicNodesKit,
  });

  useEffect(() => {
    if (filePath) {
      const decodedPath = decodeURIComponent(filePath);
      setFileUrl(decodedPath);
      // TODO: Load file content into editor
    }
  }, [filePath, setFileUrl]);

  if (!filePath) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">No file selected</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <EditorToolbar />
      <ScrollArea className="flex-1">
        <div className="mx-auto max-w-3xl px-8 py-12 min-h-[calc(100vh-8rem)]">
          <Plate editor={editor}>
            <EditorContainer>
              <Editor placeholder="# Start writing..." />
            </EditorContainer>
          </Plate>
        </div>
      </ScrollArea>
    </div>
  );
}
