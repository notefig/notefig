import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { TopNav } from "@/components/top-nav";
import { SettingsDialog } from "@/components/settings-dialog";
import { DebugPanel } from "@/components/debug-panel";
import { FileExplorer } from "@/components/file-explorer";
import { FileEditor } from "@/components/file-editor";
import { Welcome } from "@/components/welcome";
import { useMenuEvents } from "@/hooks/useMenuEvents";
import { useFileManager } from "@/hooks/useFileManager";
import { useTabNavigation } from "@/hooks/useTabNavigation";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";

export const WorkspaceLayout = () => {
  const { basePath } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { hasOpenTabs } = useFileManager();
  const tabNavigation = useTabNavigation();

  // Decode the base path from URL
  const currentDirectory = basePath ? decodeURIComponent(basePath) : undefined;

  // Check if settings modal should be open
  const showSettings = searchParams.get("settings") === "true";

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

  const currentActiveFile =
    hasOpenTabs && tabNavigation.activeIndex >= 0
      ? tabNavigation.getAbsolutePath(
          tabNavigation.tabs[tabNavigation.activeIndex],
        )
      : undefined;

  return (
    <>
      <TopNav
        currentDirectory={currentDirectory}
        selectedFile={currentActiveFile || undefined}
        isEditRoute={hasOpenTabs}
      />
      <DebugPanel
        currentDirectory={currentDirectory}
        selectedFilePath={currentActiveFile || undefined}
        isEditRoute={hasOpenTabs}
      />
      <SettingsDialog open={showSettings} onOpenChange={handleSettingsToggle} />

      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel
            defaultSize={20}
            minSize={15}
            maxSize={30}
            className="bg-sidebar"
          >
            <FileExplorer currentDirectory={currentDirectory} />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={80}>
            {hasOpenTabs ? (
              <FileEditor />
            ) : (
              <div className="h-full bg-background">
                <ScrollArea className="h-full">
                  <div className="mx-auto max-w-3xl px-8 py-12 min-h-[calc(100vh-8rem)]">
                    <Welcome onDirectorySelect={handleDirectorySelect} />
                  </div>
                </ScrollArea>
              </div>
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </>
  );
};
