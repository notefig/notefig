import { useRef } from "react";
import {
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  ExternalLink,
} from "lucide-react";
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
  onOpenInNewTab?: (path: string) => void;
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
  onOpenInNewTab,
  onRequestDelete,
  onRenameStart,
  onNewFile,
  onNewFolder,
  disableRename,
  children,
}: FileTreeContextMenuProps) {
  const { t } = useTranslation();
  const preventCloseAutoFocusRef = useRef(false);
  // For files, create in the parent directory. For directories, create inside.
  const targetDir = type === "directory" ? path : getDirectoryPath(path);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(event) => {
            if (!preventCloseAutoFocusRef.current) return;
            event.preventDefault();
            preventCloseAutoFocusRef.current = false;
          }}
        >
          {type === "file" && onOpenInNewTab ? (
            <>
              <ContextMenuItem onSelect={() => onOpenInNewTab(path)}>
                <ExternalLink className="w-4 h-4 mr-2" />
                {t("openInNewTab", "Open in New Tab")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : (
            <ContextMenuSeparator />
          )}
          <ContextMenuItem
            onSelect={() => {
              preventCloseAutoFocusRef.current = true;
              onNewFile(targetDir);
            }}
          >
            <FilePlus className="w-4 h-4 mr-2" />
            {t("newFile", "New File")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              preventCloseAutoFocusRef.current = true;
              onNewFolder(targetDir);
            }}
          >
            <FolderPlus className="w-4 h-4 mr-2" />
            {t("newFolder", "New Folder")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={disableRename}
            onSelect={() => {
              preventCloseAutoFocusRef.current = true;
              onRenameStart();
            }}
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
