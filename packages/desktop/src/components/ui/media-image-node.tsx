"use client";

import * as React from "react";
import { Suspense } from "react";

import type { TImageElement } from "platejs";
import type { PlateElementProps } from "platejs/react";

import { useDraggable } from "@platejs/dnd";
import { ImagePlugin, useMediaState } from "@platejs/media/react";
import { ResizableProvider, useResizableValue } from "@platejs/resizable";
import { PlateElement, withHOC } from "platejs/react";
import { useImageUrl } from "@/hooks/use-image-url";
import { useWorkspaceParams } from "@/hooks/use-workspace-params";

import { cn } from "@/lib/utils";

import { Caption, CaptionTextarea } from "./caption";
import { MediaToolbar } from "./media-toolbar";
import {
  mediaResizeHandleVariants,
  Resizable,
  ResizeHandle,
} from "./resize-handle";

function ImageInner(props: PlateElementProps<TImageElement>) {
  const { align = "center", focused, readOnly, selected } = useMediaState();
  const width = useResizableValue("width");
  const { workspacePath } = useWorkspaceParams();

  const { isDragging, handleRef } = useDraggable({
    element: props.element,
  });

  const elementUrl = props.element.url as string;

  // This will suspend while loading
  const displayUrl = useImageUrl(elementUrl, workspacePath ?? "");

  return (
    <MediaToolbar plugin={ImagePlugin}>
      <PlateElement {...props} className="py-2.5">
        <figure className="group relative m-0" contentEditable={false}>
          <Resizable
            align={align}
            options={{
              align,
              readOnly,
            }}
          >
            <ResizeHandle
              className={mediaResizeHandleVariants({ direction: "left" })}
              options={{ direction: "left" }}
            />
            <img
              ref={handleRef}
              src={displayUrl}
              className={cn(
                "block w-full max-w-full cursor-pointer object-cover px-0",
                "rounded-sm",
                focused && selected && "ring-2 ring-ring ring-offset-2",
                isDragging && "opacity-50",
              )}
              alt={props.attributes.alt as string | undefined}
            />
            <ResizeHandle
              className={mediaResizeHandleVariants({
                direction: "right",
              })}
              options={{ direction: "right" }}
            />
          </Resizable>

          <Caption style={{ width }} align={align}>
            <CaptionTextarea
              readOnly={readOnly}
              onFocus={(e) => {
                e.preventDefault();
              }}
              placeholder="Write a caption..."
            />
          </Caption>
        </figure>

        {props.children}
      </PlateElement>
    </MediaToolbar>
  );
}

function ImageLoading() {
  return (
    <div className="py-2.5">
      <figure className="group relative m-0" contentEditable={false}>
        <div className="flex items-center justify-center h-32 bg-muted/50 rounded-sm">
          <span className="text-muted-foreground text-sm">
            Loading image...
          </span>
        </div>
      </figure>
    </div>
  );
}

export const ImageElement = withHOC(
  ResizableProvider,
  function ImageElement(props: PlateElementProps<TImageElement>) {
    return (
      <Suspense fallback={<ImageLoading />}>
        <ImageInner {...props} />
      </Suspense>
    );
  },
);
