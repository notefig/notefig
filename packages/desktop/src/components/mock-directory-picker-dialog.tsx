import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/utils/platform";
import { cn } from "@/lib/utils";

interface MockPickDirectoryEvent extends CustomEvent {
  detail: {
    title: string;
    callback: (path: string | null) => void;
  };
}

/**
 * Mock Directory Picker Dialog
 * This component listens for mock-pick-directory events and displays a dialog
 * where users can enter a directory path for testing in web/non-Tauri environments
 */
export function MockDirectoryPickerDialog() {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState("Select Directory");
  const [path, setPath] = useState("/workspace/demo-content");
  const [callback, setCallback] = useState<
    ((path: string | null) => void) | null
  >(null);

  useEffect(() => {
    // Only set up the listener in web mode
    if (!isWeb()) return;

    const handlePickDirectory = (event: Event) => {
      const customEvent = event as MockPickDirectoryEvent;
      setTitle(customEvent.detail.title);
      setCallback(() => customEvent.detail.callback);
      setIsOpen(true);
    };

    window.addEventListener("mock-pick-directory", handlePickDirectory);

    return () => {
      window.removeEventListener("mock-pick-directory", handlePickDirectory);
    };
  }, []);

  const handleConfirm = () => {
    if (callback) {
      callback(path);
    }
    setIsOpen(false);
    setPath("/workspace/demo-content"); // Reset for next time
  };

  const handleCancel = () => {
    if (callback) {
      callback(null);
    }
    setIsOpen(false);
    setPath("/workspace/demo-content"); // Reset for next time
  };

  // Don't render in Tauri mode
  if (!isWeb()) return null;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Enter a directory path for testing. This is a mock dialog for
            web/Codespaces mode.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <label htmlFor="path" className="text-sm font-medium">
              Directory Path
            </label>
            <input
              id="path"
              type="text"
              value={path}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setPath(e.target.value)
              }
              placeholder="/workspace/demo-content"
              className={cn(
                "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
                "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 font-mono",
              )}
            />
            <p className="text-xs text-muted-foreground">
              Suggested paths: <code>/workspace/demo-content</code>,{" "}
              <code>/tmp/test</code>, <code>/home/node/projects</code>
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleCancel}>
            Cancel
          </Button>
          <Button onClick={handleConfirm}>Select Directory</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
