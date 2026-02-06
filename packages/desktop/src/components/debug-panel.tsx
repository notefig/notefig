import { useParams, useSearchParams } from "react-router-dom";

interface DebugPanelProps {
  isEditRoute: boolean;
}

export function DebugPanel({ isEditRoute }: DebugPanelProps) {
  const currentDirectory = useParams().basePath || null;
  const { basePath, "*": filePath } = useParams();
  const [searchParams] = useSearchParams();

  const selectedFilePath = searchParams.get("activeTab") || null;

  // Only show if debug environment variable is set
  if (import.meta.env.VITE_DEBUG !== "true") {
    return null;
  }

  return (
    <div className="bg-red-100 border-2 border-red-500 p-2 text-xs font-mono text-black">
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
    </div>
  );
}
