import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry } from "@/utils/fs";
import { writeFileContent } from "@/utils/collections";
import { getOrCreateEditor } from "@/components/editor/editor-store";
import { cn } from "@/lib/utils";

interface CodeEditorProps {
  file: FileEntry;
  basePath: string;
  isContentLoaded: boolean;
}

export function CodeEditor({
  file,
  basePath,
  isContentLoaded,
}: CodeEditorProps) {
  const [content, setContent] = useState(file.content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    getOrCreateEditor(file.path, { type: "code" });
  }, [file.path]);

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
    return () => clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (!isContentLoaded) return;
    setContent(file.content);
  }, [isContentLoaded, file.content]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value;
      setContent(newContent);

      if (!isContentLoaded) {
        return;
      }

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        writeFileContent(basePath, file.path, newContent);
      }, 500);
    },
    [file.path, basePath, isContentLoaded],
  );

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      data-editor-container={file.path}
      className="flex flex-col flex-1 min-h-0 w-full"
    >
      <div className="flex-1 overflow-auto p-4">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          className={cn(
            "w-full h-full min-h-[300px] resize-none",
            "font-mono text-sm",
            "bg-transparent border-0 outline-none",
            "text-foreground placeholder:text-muted-foreground",
            "focus:ring-0 focus-visible:ring-0",
          )}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
      </div>
    </div>
  );
}
