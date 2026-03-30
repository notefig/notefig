"use client";

import { useEffect } from "react";
import type { FileEntry } from "@/utils/fs";
import {
  getOrCreateEditor,
  focusEditor,
} from "@/components/editor/editor-store";
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

  // Auto-focus when this component mounts (handles panel 1+ timing issues)
  useEffect(() => {
    const rafId = requestAnimationFrame(() => {
      focusEditor(file.path);
    });
    return () => cancelAnimationFrame(rafId);
  }, [file.path]);

  // This will suspend while loading
  const imageUrl = useImageUrl(file.path, basePath);

  return (
    <div
      data-editor-container={file.path}
      className="flex flex-col flex-1 min-h-0 w-full overflow-auto"
      tabIndex={-1}
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
