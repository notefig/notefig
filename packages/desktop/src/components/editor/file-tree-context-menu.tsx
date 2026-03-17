import { FilePlus, FolderPlus, Pencil, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { getDirectoryPath } from "@/utils/fs";
import { useTranslation } from "react-i18next";

interface FileTreeContextMenuProps {
  path: string;
  type: "file" | "directory";
  onRequestDelete: (path: string, type: "file" | "directory") => void;
  onRenameStart: () => void;
  onNewFile: (parentDirPath: string) => void;
  onNewFolder: (parentDirPath: string) => void;
  disableRename?: boolean;
  children: React.ReactNode;
}

export function FileTreeContextMenu({
  path,
  type,
  onRequestDelete,
  onRenameStart,
  onNewFile,
  onNewFolder,
  disableRename,
  children,
}: FileTreeContextMenuProps) {
  const { t } = useTranslation();
  // For files, create in the parent directory. For directories, create inside.
  const targetDir = type === "directory" ? path : getDirectoryPath(path);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onNewFile(targetDir)}>
            <FilePlus className="w-4 h-4 mr-2" />
            {t("newFile", "New File")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onNewFolder(targetDir)}>
            <FolderPlus className="w-4 h-4 mr-2" />
            {t("newFolder", "New Folder")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={disableRename}
            onSelect={() => onRenameStart()}
          >
            <Pencil className="w-4 h-4 mr-2" />
            {t("rename", "Rename")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => onRequestDelete(path, type)}>
            <Trash2 className="w-4 h-4 mr-2" />
            {t("delete", "Delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
}
