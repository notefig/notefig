import "./App.css";
import * as React from "react";
import { DirectoryPicker } from "@/components/directory-picker";
import { DynamicFileTree } from "@/components/dynamic-file-tree";
import { useMenuEvents } from "@/hooks/useMenuEvents";
import { EditorToolbar } from "@/components/editor-toolbar";
import { TopNav } from "@/components/top-nav";
import { SettingsDialog } from "@/components/settings-dialog";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Icons } from "@/components/icons";
import { ThemeProvider } from "@/components/theme-provider";
import { Plate, usePlateEditor } from "platejs/react";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { BasicNodesKit } from "@/components/editor/plugins/basic-nodes-kit";

export const App = () => {
  const [showSettings, setShowSettings] = React.useState(false);

  // Directory management state
  const [currentDirectory, setCurrentDirectory] = React.useState<
    string | undefined
  >();
  const [selectedFilePath, setSelectedFilePath] = React.useState<
    string | undefined
  >();

  const editor = usePlateEditor({
    plugins: BasicNodesKit,
  });

  const handleDirectorySelect = (path: string) => {
    setCurrentDirectory(path);
    setSelectedFilePath(undefined);
  };

  const handleFileSelect = (path: string) => {
    setSelectedFilePath(path);
    // TODO: Load file content into editor
  };

  // Listen for native menu events
  useMenuEvents({
    onFolderSelected: handleDirectorySelect,
  });

  return (
    <ThemeProvider>
      <div className="flex h-screen flex-col bg-background text-foreground overflow-hidden">
        <TopNav />
        <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />
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
                <DirectoryPicker
                  currentDirectory={currentDirectory}
                  onDirectorySelect={handleDirectorySelect}
                />
                <ScrollArea className="flex-1">
                  <div className="p-2">
                    <DynamicFileTree
                      selectedPath={selectedFilePath}
                      onSelect={handleFileSelect}
                      rootDirectory={currentDirectory}
                    />
                  </div>
                </ScrollArea>
                <div className="border-t border-sidebar-border p-2">
                  <button
                    onClick={() => setShowSettings(true)}
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
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </ThemeProvider>
  );
};
