"use client";

import * as React from "react";

import { platformAdapter } from "@/adapters";

export interface UploadedMedia {
  url: string;
  name: string;
  size: number;
}

interface UseMediaUploadOptions {
  workspacePath: string;
}

export function useMediaUpload({ workspacePath }: UseMediaUploadOptions) {
  const [isUploading, setIsUploading] = React.useState(false);
  const [uploadedFile, setUploadedFile] = React.useState<UploadedMedia | null>(
    null,
  );

  const uploadFile = React.useCallback(
    async (file: File): Promise<UploadedMedia | null> => {
      setIsUploading(true);

      try {
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        const timestamp = Date.now();
        const sanitizedName = sanitizeFileName(file.name);
        const ext = getExtension(sanitizedName);
        const baseName = removeExtension(sanitizedName);
        const filename = `${baseName}-${timestamp}.${ext}`;
        const absolutePath = `${workspacePath}/${filename}`.replace(
          /\/+/g,
          "/",
        );

        const result = await platformAdapter.writeBinaryFiles([
          { path: absolutePath, data: uint8Array },
        ]);

        if (result.succeeded.length > 0) {
          const uploadedMedia: UploadedMedia = {
            url: filename,
            name: file.name,
            size: file.size,
          };
          setUploadedFile(uploadedMedia);
          return uploadedMedia;
        }
        return null;
      } catch {
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [workspacePath],
  );

  const reset = React.useCallback(() => {
    setUploadedFile(null);
    setIsUploading(false);
  }, []);

  return {
    isUploading,
    uploadedFile,
    uploadFile,
    reset,
  };
}

function sanitizeFileName(name: string): string {
  return name
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim()
    .toLowerCase();
}

function getExtension(filename: string): string {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "bin";
}

function removeExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  return lastDot > 0 ? filename.slice(0, lastDot) : filename;
}
