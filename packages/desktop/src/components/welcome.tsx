import { useState } from "react";
import { Icons } from "./icons";
import { Button } from "@/components/ui/button";
import { normalizePath, pickDirectory } from "@/utils/fs";
import Logo from "./logo";
import { useNavigate } from "react-router";

interface WelcomeProps {
  onDirectorySelect: (path: string) => void;
}

export function Welcome({ onDirectorySelect }: WelcomeProps) {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleOpenFolder = async () => {
    setLoading(true);
    try {
      const selectedPath = await pickDirectory();
      if (selectedPath) {
        const encodedPath = encodeURIComponent(normalizePath(selectedPath));
        navigate(`/${encodedPath}`);
      }
    } catch (error) {
      console.error("Failed to pick directory:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center text-center max-w-md h-full mx-auto px-4">
      <Logo
        size={96}
        animated={false}
        showBackground={false}
        fill="currentColor"
        className="text-foreground mx-auto mb-6"
      />
      <h2 className="text-xl font-semibold mb-3">Welcome to Metrists</h2>
      <p className="text-muted-foreground mb-6">
        Open a folder to start browsing and editing your files.
      </p>

      <Button
        onClick={handleOpenFolder}
        disabled={loading}
        size="lg"
        className="mb-6 flex items-center gap-3 px-8 py-3 text-base"
      >
        <Icons.folder className="h-5 w-5" />
        {loading ? "Opening..." : "Open Folder"}
      </Button>

      <div className="bg-muted/50 rounded-lg p-4 text-sm text-muted-foreground w-full">
        <div className="flex items-start gap-3 mb-2">
          <Icons.folder className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Choose a folder to browse your files</span>
        </div>
        <div className="flex items-start gap-3">
          <Icons.fileText className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Click any file to start editing</span>
        </div>
      </div>
    </div>
  );
}
