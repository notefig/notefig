"use client";

import * as React from "react";

import type { TPlaceholderElement } from "platejs";
import type { PlateElementProps } from "platejs/react";

import {
  PlaceholderPlugin,
  PlaceholderProvider,
  updateUploadHistory,
} from "@platejs/media/react";
import { AudioLines, FileUp, Film, ImageIcon, Loader2Icon } from "lucide-react";
import { KEYS } from "platejs";
import { PlateElement, useEditorPlugin, withHOC } from "platejs/react";
import { useFilePicker } from "use-file-picker";

import { cn } from "@/lib/utils";
import { useMediaUpload } from "@/hooks/use-media-upload";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";

const CONTENT: Record<
  string,
  {
    accept: string[];
    content: React.ReactNode;
    icon: React.ReactNode;
  }
> = {
  [KEYS.audio]: {
    accept: ["audio/*"],
    content: "Add an audio file",
    icon: <AudioLines />,
  },
  [KEYS.file]: {
    accept: ["*"],
    content: "Add a file",
    icon: <FileUp />,
  },
  [KEYS.img]: {
    accept: ["image/*"],
    content: "Add an image",
    icon: <ImageIcon />,
  },
  [KEYS.video]: {
    accept: ["video/*"],
    content: "Add a video",
    icon: <Film />,
  },
};

export const PlaceholderElement = withHOC(
  PlaceholderProvider,
  function PlaceholderElement(props: PlateElementProps<TPlaceholderElement>) {
    const { editor, element } = props;

    const { api } = useEditorPlugin(PlaceholderPlugin);

    const { workspacePath } = useWorkspaceParams();
    const { isUploading, uploadedFile, uploadFile } = useMediaUpload({
      workspacePath: workspacePath || "",
    });

    const currentContent = CONTENT[element.mediaType];

    const isImage = element.mediaType === KEYS.img;

    const imageRef = React.useRef<HTMLImageElement>(null);

    const { openFilePicker } = useFilePicker({
      accept: currentContent.accept,
      multiple: true,
      onFilesSelected: (data: any) => {
        const updatedFiles = data.plainFiles as File[];
        const firstFile = updatedFiles[0];
        const restFiles = updatedFiles.slice(1);

        replaceCurrentPlaceholder(firstFile);

        if (restFiles.length > 0) {
          // Use editor.tf.insert.media (added by PlaceholderPlugin via extendEditorTransforms)
          const editorWithMedia = editor as unknown as {
            tf: { insert?: { media?: (files: File[]) => void } };
          };
          editorWithMedia.tf.insert?.media?.(restFiles);
        }
      },
    });

    const replaceCurrentPlaceholder = React.useCallback(
      (file: File) => {
        void uploadFile(file);
        api.placeholder.addUploadingFile(element.id as string, file);
      },
      [api.placeholder, element.id, uploadFile],
    );

    React.useEffect(() => {
      if (!uploadedFile) return;

      const path = editor.api.findPath(element);

      editor.tf.withoutSaving(() => {
        editor.tf.removeNodes({ at: path });

        const node = {
          children: [{ text: "" }],
          initialHeight: imageRef.current?.height,
          initialWidth: imageRef.current?.width,
          isUpload: true,
          name: element.mediaType === KEYS.file ? uploadedFile.name : "",
          placeholderId: element.id as string,
          type: element.mediaType!,
          url: uploadedFile.url,
        };

        editor.tf.insertNodes(node, { at: path });

        updateUploadHistory(editor, node);
      });

      api.placeholder.removeUploadingFile(element.id as string);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uploadedFile, element.id]);

    // React dev mode will call React.useEffect twice
    const isReplaced = React.useRef(false);

    /** Paste and drop */
    React.useEffect(() => {
      if (isReplaced.current) return;

      isReplaced.current = true;
      const currentFiles = api.placeholder.getUploadingFile(
        element.id as string,
      );

      if (!currentFiles) return;

      replaceCurrentPlaceholder(currentFiles);

      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isReplaced]);

    return (
      <PlateElement className="my-1" {...props}>
        {(!isUploading || !isImage) && (
          <div
            className={cn(
              "flex cursor-pointer select-none items-center rounded-sm bg-muted p-3 pr-9 hover:bg-primary/10",
            )}
            onClick={() => !isUploading && openFilePicker()}
            contentEditable={false}
          >
            <div className="relative mr-3 flex text-muted-foreground/80 [&_svg]:size-6">
              {currentContent.icon}
            </div>
            <div className="whitespace-nowrap text-muted-foreground text-sm">
              {currentContent.content}
            </div>
          </div>
        )}

        {isImage && isUploading && <ImageProgress imageRef={imageRef} />}

        {props.children}
      </PlateElement>
    );
  },
);

export function ImageProgress({
  className,
  imageRef,
}: {
  className?: string;
  imageRef?: React.RefObject<HTMLImageElement | null>;
}) {
  return (
    <div
      className={cn(
        "relative flex h-32 items-center justify-center rounded-sm bg-muted",
        className,
      )}
      contentEditable={false}
    >
      <img
        ref={imageRef as React.LegacyRef<HTMLImageElement>}
        className="hidden"
        alt=""
        src=""
      />
      <div className="flex items-center gap-2">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        <span className="text-muted-foreground text-sm">Uploading...</span>
      </div>
    </div>
  );
}
