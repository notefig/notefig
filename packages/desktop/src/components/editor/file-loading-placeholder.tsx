import { Loader2, FileText } from "lucide-react";
import { getFileName } from "@/utils/fs";

interface FileLoadingPlaceholderProps {
  filePath: string;
}

export function FileLoadingPlaceholder({
  filePath,
}: FileLoadingPlaceholderProps) {
  const name = getFileName(filePath);

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full items-center justify-center bg-muted/30">
      <div className="flex flex-col items-center gap-4">
        <div className="relative">
          <FileText className="size-12 text-muted-foreground/50" />
        </div>
        <div className="text-center">
          <p className="text-muted-foreground font-medium">{name}</p>
          <p className="text-muted-foreground/70 text-sm">Loading...</p>
        </div>
      </div>
    </div>
  );
}
