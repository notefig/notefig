import { Icons } from "@/components/icons";

interface TopNavProps {
  currentDirectory?: string;
  selectedFile?: string;
  isEditRoute?: boolean;
}

export function TopNav({
  currentDirectory,
  selectedFile,
  isEditRoute,
}: TopNavProps) {
  const renderBreadcrumbs = () => {
    const parts = [];

    // Always start with Metrists
    parts.push(
      <span key="metrists" className="text-foreground font-medium">
        Metrists
      </span>,
    );

    // Add directory name if available
    if (currentDirectory) {
      const directoryName =
        currentDirectory.split("/").pop() || currentDirectory;
      parts.push(<Icons.chevronRight key="dir-chevron" className="h-4 w-4" />);
      parts.push(
        <span key="directory" className="text-muted-foreground">
          {directoryName}
        </span>,
      );
    }

    // Add file name if editing
    if (isEditRoute && selectedFile) {
      const fileName = selectedFile.split("/").pop() || selectedFile;
      parts.push(<Icons.chevronRight key="file-chevron" className="h-4 w-4" />);
      parts.push(
        <span key="file" className="text-foreground">
          {fileName}
        </span>,
      );
    }

    return parts;
  };

  return (
    <header className="flex h-14 items-center justify-between border-b bg-background px-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm font-medium">
          {renderBreadcrumbs()}
        </div>
        {isEditRoute && (
          <div className="ml-2 hidden items-center gap-2 text-xs text-muted-foreground md:flex">
            <span className="flex h-1.5 w-1.5 rounded-full bg-green-500" />
            Saved
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-muted">
          <Icons.cloud className="h-4 w-4" />
          <span className="hidden sm:inline">Sync</span>
        </button>
        <button className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-muted">
          <Icons.save className="h-4 w-4" />
          <span className="hidden sm:inline">Save</span>
        </button>
        <div className="mx-1 h-4 w-px bg-border" />
        <button className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow hover:bg-primary/90">
          <Icons.share className="h-4 w-4" />
          <span>Publish</span>
        </button>
      </div>
    </header>
  );
}
