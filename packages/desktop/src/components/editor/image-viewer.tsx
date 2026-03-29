"use client";

import { useEffect, useState } from "react";
import type { FileEntry } from "@/utils/fs";
import { registerEditor } from "@/components/editor/editor-store";
import { platformAdapter } from "@/adapters";
import { cn } from "@/lib/utils";
import { ImageIcon } from "lucide-react";

interface ImageViewerProps {
  file: FileEntry;
  basePath: string;
}

/**
 * Image viewer component for displaying images.
 * Read-only, no editing capabilities.
 */
export function ImageViewer({ file, basePath }: ImageViewerProps) {
  const [imageUrl, setImageUrl] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Register this viewer instance (stateless)
  useEffect(() => {
    registerEditor(file.path, { type: "image" });
  }, [file.path]);

  // Resolve the image URL
  useEffect(() => {
    let cancelled = false;

    async function loadImage() {
      setIsLoading(true);
      setError(null);

      try {
        console.log(
          "[ImageViewer] Loading image:",
          file.path,
          "basePath:",
          basePath,
        );

        // Try to resolve as asset URL first (handles workspace images)
        const url = await platformAdapter.resolveAssetUrl(file.path, basePath);

        console.log("[ImageViewer] Resolved URL:", url);

        if (!cancelled) {
          setImageUrl(url);
          setIsLoading(false);
        }
      } catch (err) {
        console.error("[ImageViewer] Failed to resolve asset URL:", err);
        if (!cancelled) {
          setError("Failed to load image");
          setIsLoading(false);
        }
      }
    }

    loadImage();

    return () => {
      cancelled = true;
    };
  }, [file.path, basePath]);

  // Prevent mousedown from stealing focus - keeps keyboard shortcuts working
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // Don't prevent default - we want normal click behavior
    // But ensure the dockable container keeps focus for keyboard shortcuts
    e.currentTarget.focus();
  };

  if (isLoading) {
    return (
      <div
        className="flex flex-col flex-1 min-h-0 w-full items-center justify-center bg-muted/30"
        tabIndex={-1}
        onMouseDown={handleMouseDown}
      >
        <div className="flex flex-col items-center gap-4">
          <ImageIcon className="size-12 text-muted-foreground/50" />
          <span className="text-muted-foreground text-sm">Loading...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex flex-col flex-1 min-h-0 w-full items-center justify-center bg-muted/30"
        tabIndex={-1}
        onMouseDown={handleMouseDown}
      >
        <div className="flex flex-col items-center gap-4 text-center px-4">
          <ImageIcon className="size-12 text-muted-foreground/50" />
          <div>
            <p className="text-muted-foreground font-medium">{error}</p>
            <p className="text-muted-foreground/70 text-sm mt-1">{file.path}</p>
            <p className="text-muted-foreground/50 text-xs mt-2">
              URL: {imageUrl || "not resolved"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col flex-1 min-h-0 w-full overflow-auto bg-muted/30"
      tabIndex={-1}
      onMouseDown={handleMouseDown}
    >
      <div className="flex-1 flex items-center justify-center p-8">
        <img
          src={imageUrl}
          alt={file.path}
          className={cn(
            "max-w-full max-h-full object-contain",
            "rounded-sm shadow-sm",
          )}
          onError={(e) => {
            console.error("[ImageViewer] Image failed to load:", imageUrl, e);
            setError("Failed to load image");
          }}
        />
      </div>
    </div>
  );
}
