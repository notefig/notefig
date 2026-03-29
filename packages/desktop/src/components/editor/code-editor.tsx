import { useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry } from "@/utils/fs";
import { writeFileContent } from "@/utils/collections";
import { getOrCreateEditor } from "@/components/editor/editor-store";
import { cn } from "@/lib/utils";

interface CodeEditorProps {
  file: FileEntry;
  basePath: string;
}

export function CodeEditor({ file, basePath }: CodeEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [content, setContent] = useState(file.content);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    getOrCreateEditor(file.path, {
      type: "code",
      textareaRef,
    });
  }, [file.path]);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newContent = e.target.value;
      setContent(newContent);

      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }

      saveTimeoutRef.current = setTimeout(() => {
        writeFileContent(basePath, file.path, newContent);
      }, 500);
    },
    [file.path, basePath],
  );

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  return (
    <div className="flex flex-col flex-1 min-h-0 w-full">
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
