"use client";

import { useEffect } from "react";
import type { FileEntry } from "@/utils/fs";
import { getOrCreateEditor } from "@/components/editor/editor-store";
import { useImageUrl } from "@/hooks/use-image-url";
import { cn } from "@/lib/utils";

interface ImageViewerProps {
  file: FileEntry;
  basePath: string;
}

/**
 * Image viewer component for displaying images.
 * Read-only, no editing capabilities.
 *
 * Must be wrapped in a Suspense boundary.
 */
export function ImageViewer({ file, basePath }: ImageViewerProps) {
  // Register this viewer instance
  useEffect(() => {
    getOrCreateEditor(file.path, { type: "image" });
  }, [file.path]);

  // This will suspend while loading
  const imageUrl = useImageUrl(file.path, basePath);

  // Prevent mousedown from stealing focus - keeps keyboard shortcuts working
  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    e.currentTarget.focus();
  };

  return (
    <div
      data-editor-container={file.path}
      className="flex flex-col flex-1 min-h-0 w-full overflow-auto"
      tabIndex={-1}
      onMouseDown={handleMouseDown}
    >
      <div className="flex-1 flex items-center justify-center p-4">
        <img
          src={imageUrl}
          alt={file.path}
          className={cn(
            "max-w-full max-h-full object-contain",
            "rounded-sm shadow-sm",
          )}
          onError={(e) => {
            console.error("[ImageViewer] Image failed to load:", imageUrl, e);
          }}
        />
      </div>
    </div>
  );
}
