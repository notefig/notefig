import { FileText, FileWarning } from "lucide-react";
import { getFileName } from "@/utils/fs";

interface FileLoadingPlaceholderProps {
  filePath: string;
  /** When set, shows a load-failure state instead of the loading state. */
  error?: string;
}

export function FileLoadingPlaceholder({
  filePath,
  error,
}: FileLoadingPlaceholderProps) {
  const name = getFileName(filePath);

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full items-center justify-center bg-muted/30">
      <div className="flex flex-col items-center gap-4 max-w-md px-4">
        <div className="relative">
          {error ? (
            <FileWarning className="size-12 text-destructive/60" />
          ) : (
            <FileText className="size-12 text-muted-foreground/50" />
          )}
        </div>
        <div className="text-center">
          <p className="text-muted-foreground font-medium">{name}</p>
          {error ? (
            <p className="text-destructive/80 text-sm break-words">
              Failed to load file: {error}
            </p>
          ) : (
            <p className="text-muted-foreground/70 text-sm">Loading...</p>
          )}
        </div>
      </div>
    </div>
  );
}
