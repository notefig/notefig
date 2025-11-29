import React from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { Icons } from "@/components/icons";
import { FileState } from "@/atoms/fileSystem";
import { cn } from "@/lib/utils";

interface TabItem {
  index: number;
  filePath: string;
  relativePath: string;
}

interface TabBarProps {
  tabs: TabItem[];
  activeTabIndex: number;
  onTabSwitch: (index: number) => void;
  onTabClose: (filePath: string) => void;
  allFiles: Record<string, FileState>;
}

function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "md":
    case "markdown":
      return Icons.fileText;
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
      return Icons.fileCode;
    case "json":
      return Icons.fileCode;
    case "txt":
      return Icons.fileText;
    default:
      return Icons.file;
  }
}

function getFileName(path: string): string {
  return path.split("/").pop() || "Untitled";
}

function isFileModified(
  filePath: string,
  allFiles: Record<string, FileState>,
): boolean {
  const file = allFiles[filePath];
  return file?.state === "loaded_modified";
}

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabIndex,
  onTabSwitch,
  onTabClose,
  allFiles,
}) => {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-border bg-background">
      <div className="w-full overflow-x-auto overflow-y-hidden">
        <Tabs
          value={activeTabIndex.toString()}
          onValueChange={(value) => onTabSwitch(parseInt(value, 10))}
          className="w-full"
        >
          <TabsList className="h-10 bg-transparent p-0 w-max rounded-none justify-start">
            {tabs.map((tab) => {
              const fileName = getFileName(tab.relativePath);
              const FileIcon = getFileIcon(fileName);
              const isModified = isFileModified(tab.filePath, allFiles);
              const file = allFiles[tab.filePath];
              const isLoading = file?.state === "loading";
              const hasError = file?.state === "error";

              return (
                <div
                  key={tab.filePath}
                  className="relative group"
                  title={tab.relativePath} // HTML title for hover tooltip
                >
                  <TabsTrigger
                    value={tab.index.toString()}
                    className={cn(
                      "relative flex items-center gap-2 h-10 px-3 py-2 rounded-none border-r border-border",
                      "bg-transparent hover:bg-muted/50",
                      "data-[state=active]:bg-background data-[state=active]:border-b-2 data-[state=active]:border-b-primary data-[state=active]:border-r",
                      "max-w-[200px] min-w-[120px]", // Set max width for ellipsis, min width for usability
                      "transition-all duration-200",
                      "group-hover:pr-8", // Add padding when close button appears
                    )}
                  >
                    {/* File Icon */}
                    <FileIcon className="h-4 w-4 shrink-0" />

                    {/* File Name with flex grow and ellipsis - this will shrink when close button appears */}
                    <span className="truncate text-sm font-medium flex-1 min-w-0">
                      {fileName}
                    </span>

                    {/* Status indicators - fixed width to prevent layout shift */}
                    <div className="flex items-center gap-1 shrink-0">
                      {isLoading && (
                        <div className="animate-spin h-3 w-3">
                          <Icons.folder className="h-3 w-3" />
                        </div>
                      )}

                      {hasError && (
                        <Icons.alertCircle className="h-3 w-3 text-destructive" />
                      )}

                      {isModified && !isLoading && !hasError && (
                        <div className="h-2 w-2 rounded-full bg-primary" />
                      )}
                    </div>

                    {/* Close button - appears on hover and takes space from title */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onTabClose(tab.filePath);
                      }}
                      className={cn(
                        "absolute right-1 top-1/2 -translate-y-1/2 z-10",
                        "h-5 w-5 rounded-sm flex items-center justify-center",
                        "opacity-0 group-hover:opacity-100 transition-opacity duration-200",
                        "hover:bg-muted-foreground/20 hover:text-foreground",
                        "focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-ring",
                      )}
                      title="Close tab"
                      type="button"
                    >
                      <Icons.x className="h-3 w-3" />
                    </button>
                  </TabsTrigger>
                </div>
              );
            })}
          </TabsList>
        </Tabs>
      </div>
    </div>
  );
};
