import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import type { Value } from "platejs";
import { DynamicFileTree } from "@/components/dynamic-file-tree";
import { useMenuEvents } from "@/hooks/useMenuEvents";
import { EditorToolbar } from "@/components/editor-toolbar";
import { TopNav } from "@/components/top-nav";
import { SettingsDialog } from "@/components/settings-dialog";
import { DebugPanel } from "@/components/debug-panel";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Icons } from "@/components/icons";
import { Welcome } from "@/components/welcome";
import { editorTextAtom, fileUrlAtom } from "@/atoms";
import { readAbsoluteTextFile } from "@/utils/fs";
import { getFilePathFromUrl } from "@/utils/routing";
import { Plate, usePlateEditor } from "platejs/react";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { BasicNodesKit } from "@/components/editor/plugins/basic-nodes-kit";

export const WorkspaceLayout = () => {
  const { basePath, "*": filePath } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [editorText, setEditorText] = useAtom(editorTextAtom);
  const [fileUrl, setFileUrl] = useAtom(fileUrlAtom);
  const [loading, setLoading] = useState(false);
  const [editorValue, setEditorValue] = useState<Value>([
    {
      type: "p",
      children: [{ text: "" }],
    },
  ]);

  // Decode the base path from URL
  const currentDirectory = basePath ? decodeURIComponent(basePath) : undefined;

  // Determine if we're on an edit route
  const isEditRoute = window.location.pathname.includes("/edit/");

  // Decode the file path from URL (only for edit routes)
  const selectedFilePath =
    isEditRoute && filePath && basePath
      ? getFilePathFromUrl(basePath, filePath)
      : undefined;

  // Check if settings modal should be open
  const showSettings = searchParams.get("settings") === "true";

  // Initialize Plate editor with basic markdown support
  const editor = usePlateEditor({
    plugins: BasicNodesKit,
    value: editorValue,
  });

  // Load file content when selectedFilePath changes
  useEffect(() => {
    const loadFileContent = async () => {
      if (selectedFilePath) {
        setLoading(true);
        try {
          const content = await readAbsoluteTextFile(selectedFilePath);
          setEditorText(content);
          setFileUrl(selectedFilePath);

          // Convert text content to Plate Value format
          const newValue: Value = content
            ? [{ type: "p", children: [{ text: content }] }]
            : [{ type: "p", children: [{ text: "" }] }];

          setEditorValue(newValue);

          // Use Plate's setValue method to update editor
          if (editor) {
            editor.tf.setValue(newValue);
          }
        } catch (error) {
          console.error("Failed to load file content:", error);
          const errorText = `Error loading file: ${error}`;
          setEditorText(errorText);

          const errorValue: Value = [
            { type: "p", children: [{ text: errorText }] },
          ];
          setEditorValue(errorValue);

          if (editor) {
            editor.tf.setValue(errorValue);
          }
        } finally {
          setLoading(false);
        }
      }
    };

    loadFileContent();
  }, [selectedFilePath, setEditorText, setFileUrl, editor]);

  const handleDirectorySelect = (path: string) => {
    // Navigate to base path only (no file selected)
    // Ensure we maintain the leading slash
    const normalizedPath = path.startsWith("/") ? path : "/" + path;
    const encodedBasePath = encodeURIComponent(normalizedPath);
    navigate(`/${encodedBasePath}`);
  };

  const handleSettingsToggle = (open: boolean) => {
    if (open) {
      searchParams.set("settings", "true");
    } else {
      searchParams.delete("settings");
    }
    setSearchParams(searchParams);
  };

  // Listen for native menu events
  useMenuEvents({
    onFolderSelected: handleDirectorySelect,
  });

  return (
    <>
      <TopNav
        currentDirectory={currentDirectory}
        selectedFile={selectedFilePath}
        isEditRoute={isEditRoute}
      />
      <DebugPanel
        currentDirectory={currentDirectory}
        selectedFilePath={selectedFilePath}
        isEditRoute={isEditRoute}
      />
      <SettingsDialog open={showSettings} onOpenChange={handleSettingsToggle} />
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel
            defaultSize={20}
            minSize={15}
            maxSize={30}
            className="bg-sidebar min-w-[200px]"
          >
            <div className="flex h-full flex-col">
              <div className="flex h-10 items-center justify-between px-4 border-b border-sidebar-border">
                <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Explorer
                </span>
                <button className="text-muted-foreground hover:text-foreground">
                  <Icons.moreHorizontal className="h-4 w-4" />
                </button>
              </div>
              <ScrollArea className="flex-1">
                <div className="p-2">
                  {currentDirectory ? (
                    <DynamicFileTree
                      selectedPath={selectedFilePath}
                      rootDirectory={currentDirectory}
                    />
                  ) : (
                    <div className="text-center text-sm text-muted-foreground py-8">
                      <Icons.folder className="h-8 w-8 mx-auto mb-3 opacity-50" />
                      <p>No folder selected</p>
                      <p className="text-xs mt-1">
                        Open a folder to browse files
                      </p>
                    </div>
                  )}
                </div>
              </ScrollArea>
              <div className="border-t border-sidebar-border p-2">
                <button
                  onClick={() => handleSettingsToggle(true)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                >
                  <Icons.settings className="h-4 w-4" />
                  <span>Settings</span>
                </button>
              </div>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={80}>
            <div className="flex h-full flex-col bg-background">
              {isEditRoute && <EditorToolbar />}
              <div className="flex-1 h-full overflow-hidden">
                {isEditRoute && selectedFilePath ? (
                  loading ? (
                    <div className="flex items-center justify-center h-full">
                      <div className="animate-spin">
                        <Icons.folder className="h-8 w-8 text-muted-foreground" />
                      </div>
                      <span className="ml-2 text-muted-foreground">
                        Loading file...
                      </span>
                    </div>
                  ) : (
                    <div className="h-full">
                      <Plate
                        editor={editor}
                        onChange={({ value }) => {
                          // Convert Plate value back to plain text and sync with atom
                          const text = value
                            .map(
                              (node: any) =>
                                node.children
                                  ?.map((child: any) => child.text || "")
                                  .join("") || "",
                            )
                            .join("\n");
                          setEditorText(text);
                          setEditorValue(value);
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
                  )
                ) : (
                  <ScrollArea className="h-full">
                    <div className="mx-auto max-w-3xl px-8 py-12 min-h-[calc(100vh-8rem)]">
                      <Welcome onDirectorySelect={handleDirectorySelect} />
                    </div>
                  </ScrollArea>
                )}
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </>
  );
};
