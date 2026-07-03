import { Component, Suspense, useState, type ReactNode } from "react";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { useImageUrl } from "@/hooks/use-image-url";

export function EditorImage(props: NodeViewProps) {
  const src = props.node.attrs.src as string;
  const workspaceRoot =
    (props.extension.options as Record<string, string>).workspaceRoot || "/";

  if (
    !src ||
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:")
  ) {
    return (
      <NodeViewWrapper data-drag-handle>
        <img src={src} alt="" draggable={false} />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper data-drag-handle>
      <ImageErrorBoundary fallback={<BrokenImage src={src} />}>
        <Suspense fallback={<div className="h-8 w-full animate-pulse rounded bg-muted" />}>
          <EditorImageInner src={src} workspaceRoot={workspaceRoot} />
        </Suspense>
      </ImageErrorBoundary>
    </NodeViewWrapper>
  );
}

function EditorImageInner({
  src,
  workspaceRoot,
}: {
  src: string;
  workspaceRoot: string;
}) {
  // Throws its promise while loading (Suspense) and the resolution error on
  // failure (caught by ImageErrorBoundary). Rejections are cached until
  // reload, so a repaired file stays broken for the session.
  const url = useImageUrl(src, workspaceRoot);
  const [broken, setBroken] = useState(false);

  if (broken) {
    return <BrokenImage src={src} />;
  }

  return (
    <img
      // A natively draggable <img> puts the *resolved* URL (asset://, data:)
      // into dataTransfer, which handleDrop mistakes for an OS file drop and
      // PM's HTML parser would persist into markdown. Drag the PM node via
      // the wrapper's data-drag-handle instead.
      draggable={false}
      src={url}
      alt=""
      onError={() => setBroken(true)}
    />
  );
}

function BrokenImage({ src }: { src: string }) {
  return (
    <div className="flex h-12 items-center gap-2 rounded border border-dashed border-muted-foreground/30 px-3 text-xs text-muted-foreground">
      <span>⚠</span>
      <span className="truncate">{src}</span>
    </div>
  );
}

class ImageErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}
