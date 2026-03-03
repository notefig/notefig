import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { getFileName } from "@/utils/fs";
import { useTranslation } from "react-i18next";

interface FileTreeContextMenuProps {
  path: string;
  type: "file" | "directory";
  onDelete: (path: string) => void;
  onRenameStart: () => void;
  disableRename?: boolean;
  children: React.ReactNode;
}

export function FileTreeContextMenu({
  path,
  type,
  onDelete,
  onRenameStart,
  disableRename,
  children,
}: FileTreeContextMenuProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const { t } = useTranslation();
  const name = getFileName(path);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={disableRename}
            onSelect={() => onRenameStart()}
          >
            <Pencil className="w-4 h-4 mr-2" />
            {t("rename", "Rename")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => setShowDeleteConfirm(true)}>
            <Trash2 className="w-4 h-4 mr-2" />
            {t("delete", "Delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {showDeleteConfirm && (
        <AlertDialog
          open={showDeleteConfirm}
          onOpenChange={setShowDeleteConfirm}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("deleteConfirmTitle", 'Delete "{{name}}"?', { name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {type === "directory"
                  ? t(
                      "deleteDirectoryConfirm",
                      "This will permanently delete the folder and all its contents. This action cannot be undone.",
                    )
                  : t(
                      "deleteFileConfirm",
                      "This will permanently delete the file. This action cannot be undone.",
                    )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("cancel", "Cancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDelete(path)}>
                {t("delete", "Delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
