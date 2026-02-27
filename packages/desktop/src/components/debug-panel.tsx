import { useParams, useSearchParams } from "react-router-dom";
import type { LayoutNode } from "@/components/dockable";

interface DebugPanelProps {
  isEditRoute: boolean;
  openTabs?: string[];
  activeTabId?: string | null;
  dockableLayout?: LayoutNode[];
}

export function DebugPanel({
  isEditRoute,
  openTabs,
  activeTabId,
  dockableLayout,
}: DebugPanelProps) {
  const currentDirectory = useParams().basePath || null;
  const { basePath, "*": filePath } = useParams();
  const [searchParams] = useSearchParams();

  const selectedFilePath = searchParams.get("activeTab") || null;

  // Only show if debug environment variable is set
  if (import.meta.env.VITE_DEBUG !== "true") {
    return null;
  }

  return (
    <div className="bg-red-100 border-2 border-red-500 p-2 text-xs font-mono text-black overflow-auto max-h-64">
      <div>
        <strong>Current URL:</strong> {location.pathname}
        {location.search}
      </div>
      <div>
        <strong>basePath param:</strong> {basePath || "undefined"}
      </div>
      <div>
        <strong>filePath param (*):</strong> {filePath || "undefined"}
      </div>
      <div>
        <strong>currentDirectory:</strong> {currentDirectory || "undefined"}
      </div>
      <div>
        <strong>selectedFilePath:</strong> {selectedFilePath || "undefined"}
      </div>
      <div>
        <strong>isEditRoute:</strong> {isEditRoute ? "true" : "false"}
      </div>
      <div>
        <strong>searchParams:</strong> {searchParams.toString()}
      </div>

      {/* ── Dockable tab/layout state ── */}
      {openTabs !== undefined && (
        <>
          <hr className="my-1 border-red-300" />
          <div>
            <strong>openTabs ({openTabs.length}):</strong>
          </div>
          <ul className="ml-4 list-disc">
            {openTabs.map((tab) => (
              <li key={tab} className={tab === activeTabId ? "font-bold" : ""}>
                {tab}
                {tab === activeTabId ? " (active)" : ""}
              </li>
            ))}
          </ul>
          <div>
            <strong>activeTabId:</strong> {activeTabId || "null"}
          </div>
        </>
      )}

      {dockableLayout !== undefined && (
        <>
          <hr className="my-1 border-red-300" />
          <div>
            <strong>Dockable Layout:</strong>
          </div>
          <pre className="whitespace-pre-wrap break-all text-[10px] leading-tight mt-1 bg-red-50 p-1 rounded border border-red-200">
            {JSON.stringify(dockableLayout, null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}
