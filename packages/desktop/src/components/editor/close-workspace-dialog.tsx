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
import { closeWorkspace } from "@/entities/workspaces";
import { useRunningTaskCounts } from "@/entities/agents";
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
  const runningCounts = useRunningTaskCounts();
  const [pending, setPending] = useState<PendingClose | null>(null);

  const requestClose = useCallback(
    (path: string) => {
      const runningCount = runningCounts.get(workspaceKey(path)) ?? 0;
      if (runningCount === 0) {
        void closeWorkspace(path);
        return;
      }
      setPending({ path, name: deriveProjectName(path), runningCount });
    },
    [runningCounts],
  );

  const dialog = (
    <CloseWorkspaceDialog
      pending={pending}
      onCancel={() => setPending(null)}
      onConfirm={(path) => {
        void closeWorkspace(path);
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
