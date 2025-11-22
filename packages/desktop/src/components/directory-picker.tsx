import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Icons } from "@/components/icons";
import { invoke } from "@tauri-apps/api/core";

interface DirectoryPickerProps {
  onDirectorySelect: (path: string) => void;
  currentDirectory?: string;
}

export function DirectoryPicker({
  onDirectorySelect,
  currentDirectory,
}: DirectoryPickerProps) {
  const [loading, setLoading] = useState(false);

  const handlePickDirectory = async () => {
    setLoading(true);
    try {
      // Use the native command instead of the frontend dialog
      const selectedPath = await invoke<string | null>("open_folder_dialog");

      if (selectedPath) {
        onDirectorySelect(selectedPath);
      }
    } catch (error) {
      console.error("Failed to pick directory:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-2 p-2 border-b border-sidebar-border">
      <Button
        onClick={handlePickDirectory}
        disabled={loading}
        size="sm"
        variant="ghost"
        className="flex items-center gap-2"
      >
        <Icons.folder className="h-4 w-4" />
        {loading ? "Loading..." : "Open Folder"}
      </Button>

      {currentDirectory && (
        <div className="flex-1 min-w-0 flex items-center gap-1">
          <Icons.folder className="h-3 w-3 text-muted-foreground shrink-0" />
          <p
            className="text-xs text-muted-foreground truncate"
            title={currentDirectory}
          >
            {currentDirectory.split("/").pop() || currentDirectory}
          </p>
        </div>
      )}
    </div>
  );
}
