import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { TopNav } from "@/components/top-nav";
import { SettingsDialog } from "@/components/settings-dialog";
import { DebugPanel } from "@/components/debug-panel";
import { FileExplorer } from "@/components/file-explorer";
import { FileEditor } from "@/components/file-editor";
import { Welcome } from "@/components/welcome";
import { useMenuEvents } from "@/hooks/useMenuEvents";
import { getFilePathFromUrl } from "@/utils/routing";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { ScrollArea } from "@/components/ui/scroll-area";

export const WorkspaceLayout = () => {
  const { basePath, "*": filePath } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();

  // Decode the base path from URL
  const currentDirectory = basePath ? decodeURIComponent(basePath) : undefined;

  // Determine if we're on an edit route
  const isEditRoute = window.location.pathname.includes("/edit/");

  // Decode the file path from URL (only for edit routes)
  const selectedFilePath =
    isEditRoute && filePath && basePath
      ? getFilePathFromUrl(basePath, filePath) || undefined
      : undefined;

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
            className="bg-sidebar"
          >
            <FileExplorer
              currentDirectory={currentDirectory}
              selectedPath={selectedFilePath}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={80}>
            {isEditRoute && selectedFilePath ? (
              <FileEditor filePath={selectedFilePath} />
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
