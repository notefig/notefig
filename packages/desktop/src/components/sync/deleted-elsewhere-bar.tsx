/**
 * Above an editor whose file another device deleted while it was open
 * here (MET-277): sync keeps the file until the user restores it for
 * everyone or closes it here too. A leaf, for the text editor.
 */
import { useTranslation } from "react-i18next";
import { useCore } from "@notefig/core/react";
import { Button } from "@notefig/ui/button";
import { useSyncState } from "@/modules/sync/react";
import { relativeTreePath } from "@/utils/path";

export function DeletedElsewhereBar({ workspacePath, path }: { workspacePath: string; path: string }) {
  const { t } = useTranslation();
  const core = useCore();
  const { deleted } = useSyncState(workspacePath);
  const relative = relativeTreePath(workspacePath, path);
  const entry = deleted.find((item) => item.path === relative);
  if (!entry || relative === undefined) return null;
  const sync = core.workspace(workspacePath).sync;
  return (
    <div role="status" className="flex shrink-0 items-center gap-3 border-b bg-card px-3 py-2 text-sm">
      <span className="flex-1 text-muted-foreground">
        {entry.by ? t("syncDeletedBy", { name: entry.by }) : t("syncDeletedElsewhere")}
      </span>
      <Button variant="outline" size="sm" onClick={() => void sync.restoreDeleted(relative)}>
        {t("syncRestore")}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void sync.discardDeleted(relative)}>
        {t("close")}
      </Button>
    </div>
  );
}
