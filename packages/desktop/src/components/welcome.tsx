import { Icons } from "./icons";

export function Welcome() {
  return (
    <div className="flex flex-col items-center justify-center text-center max-w-md mx-auto px-4">
      <Icons.fileText className="h-16 w-16 text-muted-foreground mx-auto mb-6" />
      <h2 className="text-xl font-semibold mb-3">Welcome to Metrists</h2>
      <p className="text-muted-foreground mb-6">
        Open a folder to start browsing and editing your files.
      </p>
      <div className="bg-muted/50 rounded-lg p-4 text-sm text-muted-foreground w-full">
        <div className="flex items-start gap-3 mb-2">
          <Icons.folder className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Use "Open Folder" to browse files</span>
        </div>
        <div className="flex items-start gap-3">
          <Icons.fileText className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Click any file to start editing</span>
        </div>
      </div>
    </div>
  );
}
