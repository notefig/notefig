import { useSearchParams } from "react-router-dom";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Icons } from "@/components/icons";
import { DynamicFileTree } from "@/components/dynamic-file-tree";

interface FileExplorerProps {
  currentDirectory?: string;
}

export const FileExplorer = ({ currentDirectory }: FileExplorerProps) => {
  const [searchParams, setSearchParams] = useSearchParams();

  const handleSettingsToggle = (open: boolean) => {
    if (open) {
      searchParams.set("settings", "true");
    } else {
      searchParams.delete("settings");
    }
    setSearchParams(searchParams);
  };

  return (
    <div className="flex h-full flex-col bg-sidebar min-w-[200px]">
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
            <DynamicFileTree rootDirectory={currentDirectory} />
          ) : (
            <div className="text-center text-sm text-muted-foreground py-8">
              <Icons.folder className="h-8 w-8 mx-auto mb-3 opacity-50" />
              <p>No folder selected</p>
              <p className="text-xs mt-1">Open a folder to browse files</p>
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
  );
};
