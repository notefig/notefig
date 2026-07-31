import { useCallback, useEffect, useRef, useState } from "react";
import ForceGraph2D, { type NodeObject } from "react-force-graph-2d";
import { Loader2 } from "lucide-react";
import type { GraphNode } from "@/utils/graph-data";
import { useWorkspaceGraphData } from "@/hooks/use-workspace-graph-data";
import { useWorkspaceTabs } from "@/components/workspace-tabs-provider";

interface GraphViewTabProps {
  workspacePath: string;
}

/** Re-renders when the resolved light/dark theme changes (class on <html>). */
function useThemeColors() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => forceUpdate((n) => n + 1));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // Recomputed every render (including the forceUpdate above) — cheap, and
  // this component doesn't re-render on a hot path (ForceGraph2D's own
  // animation loop lives inside the canvas library, not React state).
  const style = getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    node: `hsl(${read("--foreground")})`,
    link: `hsl(${read("--muted-foreground")} / 0.35)`,
    text: `hsl(${read("--muted-foreground")})`,
  };
}

function useContainerSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, size };
}

export function GraphViewTab({ workspacePath }: GraphViewTabProps) {
  const { openFile } = useWorkspaceTabs();
  const { ref: containerRef, size } = useContainerSize();
  const colors = useThemeColors();

  const { graphData, markdownPaths, isLoading } =
    useWorkspaceGraphData(workspacePath);

  const handleNodeClick = useCallback(
    (node: NodeObject<GraphNode>) => {
      if (typeof node.id !== "string") return;
      openFile({ tabId: node.id, intent: "new-tab" });
    },
    [openFile],
  );

  const nodeCanvasObject = useCallback(
    (
      node: NodeObject<GraphNode>,
      ctx: CanvasRenderingContext2D,
      globalScale: number,
    ) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;

      ctx.beginPath();
      ctx.arc(x, y, 4, 0, 2 * Math.PI, false);
      ctx.fillStyle = colors.node;
      ctx.fill();

      const fontSize = 12 / globalScale;
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillStyle = colors.text;
      ctx.fillText(node.label ?? "", x, y + 6);
    },
    [colors],
  );

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  if (markdownPaths.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground p-4">
        <p className="text-center">No markdown files in this workspace yet.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full w-full bg-background">
      {size.width > 0 && size.height > 0 && (
        <ForceGraph2D
          graphData={graphData}
          width={size.width}
          height={size.height}
          backgroundColor="rgba(0,0,0,0)"
          linkColor={() => colors.link}
          nodeCanvasObject={nodeCanvasObject}
          nodeLabel={(node) => node.label ?? ""}
          onNodeClick={handleNodeClick}
        />
      )}
    </div>
  );
}
