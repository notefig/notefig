import { Component, Suspense, useState, type ReactNode } from "react";
import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { useImageUrl } from "@/hooks/use-image-url";
import { dragSourceProps } from "@/utils/drag-protocol";
import { path as pathutil } from "@/utils/path";

export function EditorImage(props: NodeViewProps) {
  const src = props.node.attrs.src as string;
  const options = props.extension.options as Record<string, string>;
  const workspaceRoot = options.workspaceRoot || "/";
  const filePath = options.filePath || "";

  // Focus containment. The node view is a non-editable island, so the
  // browser's default reaction to pressing it is to move DOM focus to the
  // nearest focusable ancestor — outside the editor, onto the dockable
  // pane's tabindex=-1 wrapper — while ProseMirror selects the node.
  // Backspace would then go to that pane div. tabIndex makes the island
  // itself the nearest focusable element, and onFocus hands the focus
  // straight to the editor without disturbing the selection. (mousedown
  // preventDefault would also stop the focus transfer, but ProseMirror
  // skips node selection and the browser skips drag initiation for
  // default-prevented presses.)
  const containFocus = () => {
    props.editor.commands.focus(null, { scrollIntoView: false });
  };

  if (
    !src ||
    src.startsWith("http://") ||
    src.startsWith("https://") ||
    src.startsWith("data:")
  ) {
    return (
      <NodeViewWrapper data-drag-handle tabIndex={-1} onFocus={containFocus}>
        <img src={src} alt="" draggable={false} />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      data-drag-handle
      tabIndex={-1}
      onFocus={containFocus}
      // Drag-protocol payload for external drop zones; ProseMirror still
      // owns the drag itself, so in-editor moves keep moved=true semantics.
      {...dragSourceProps({
        kind: "image-asset",
        src,
        absolutePath: pathutil.join(workspaceRoot, pathutil.fromTreePath(src)),
        workspaceRoot,
        sourceFilePath: filePath,
      })}
    >
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
