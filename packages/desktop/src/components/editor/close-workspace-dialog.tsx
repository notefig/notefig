import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@notefig/ui/alert-dialog";
import { useCore } from "@notefig/core/react";
import { useRunningTaskCounts } from "@/modules/agents/react";
import { deriveProjectName } from "@/hooks/use-recent-projects";
import { workspaceKey } from "@/utils/path";

interface PendingClose {
  path: string;
  name: string;
  runningCount: number;
}

/**
 * Closing a workspace, with the one interruption that matters: a workspace
 * with agent tasks mid-run asks first (closing demotes them to restorable
 * sessions); an idle one closes at once (MET-177).
 */
export function useCloseWorkspace(): {
  requestClose: (path: string) => void;
  dialog: React.ReactNode;
} {
  const core = useCore();
  const runningCounts = useRunningTaskCounts();
  const [pending, setPending] = useState<PendingClose | null>(null);

  const requestClose = useCallback(
    (path: string) => {
      const runningCount = runningCounts.get(workspaceKey(path)) ?? 0;
      if (runningCount === 0) {
        void core.workspace(path).close();
        return;
      }
      setPending({ path, name: deriveProjectName(path), runningCount });
    },
    [core, runningCounts],
  );

  const dialog = (
    <CloseWorkspaceDialog
      pending={pending}
      onCancel={() => setPending(null)}
      onConfirm={(path) => {
        void core.workspace(path).close();
        setPending(null);
      }}
    />
  );

  return { requestClose, dialog };
}

/** Confirmation shown only when closing would interrupt running tasks. */
function CloseWorkspaceDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingClose | null;
  onCancel: () => void;
  onConfirm: (path: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("closeWorkspaceTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("closeWorkspaceBody", {
              name: pending?.name ?? "",
              count: pending?.runningCount ?? 0,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (pending) onConfirm(pending.path);
            }}
          >
            {t("closeWorkspaceConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
