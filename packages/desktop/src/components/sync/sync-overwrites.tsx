/**
 * The status bar's flag for text a sync merge overwrote: shown only at the
 * shared level, only while there is something to show. It opens a list of
 * the fragments (the losing side of each overlap) to read, copy or dismiss;
 * the full local version stays on the recovery ref each entry names.
 */
import { Copy, TriangleAlert, X } from "lucide-react";
import { Button } from "@notefig/ui/button";
import { copyTextToClipboard } from "@notefig/ui/clipboard";
import { Popover, PopoverContent, PopoverTrigger } from "@notefig/ui/popover";
import { useWorkspaceModule } from "@notefig/core/react";
import { useSyncCapabilities, useSyncOverwrites } from "@/modules/sync/react";
import type { SyncOverwriteRecord } from "@/modules/sync";
import { path as pathutil } from "@/utils/path";

export function SyncOverwritesCell({ workspacePath }: { workspacePath: string | null }) {
  const capabilities = useSyncCapabilities(workspacePath);
  const records = useSyncOverwrites(workspacePath);
  if (!capabilities.merges || records.length === 0 || !workspacePath) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sync-overwrites"
          className="flex items-center gap-1.5 text-warning hover:text-foreground"
        >
          <TriangleAlert className="w-3.5 h-3.5" />
          <span>{records.length} overwritten</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-h-96 overflow-auto p-3 space-y-3">
        <p className="text-xs text-muted-foreground">
          Someone else edited the same text at the same time; their version was kept. Your
          text is below, and saved on the local recovery ref.
        </p>
        {records.map((record) => (
          <OverwriteEntry key={record.id} workspacePath={workspacePath} record={record} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function OverwriteEntry({
  workspacePath,
  record,
}: {
  workspacePath: string;
  record: SyncOverwriteRecord;
}) {
  const sync = useWorkspaceModule(workspacePath, "sync");
  const text = record.binary
    ? "The other version of this file was kept; yours is on the recovery ref."
    : record.fragments.join("\n\n");
  return (
    <div className="space-y-1" data-testid="sync-overwrite">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium truncate">{pathutil.basename(record.path)}</span>
        <span className="flex gap-1">
          {!record.binary && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Copy"
              onClick={() => void copyTextToClipboard(text)}
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-label="Dismiss"
            onClick={() => sync?.dismissOverwrite(record.id)}
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </span>
      </div>
      <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{text}</pre>
      {record.recoveryRef && (
        <p className="text-[10px] text-muted-foreground break-all">{record.recoveryRef}</p>
      )}
    </div>
  );
}
