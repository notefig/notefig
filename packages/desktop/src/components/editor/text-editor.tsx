import { useCallback, useEffect, useRef } from "react";
import type { FileEntry } from "../../utils/fs";

interface TextEditorProps {
  onChange: (content: string) => void;
  file: FileEntry;
}

export function TextEditor({ onChange, file }: TextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange],
  );

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  return (
    <div className="flex flex-col h-full w-full bg-background overflow-hidden">
      <div className="flex items-center justify-center py-6 shrink-0">
        <h1 className="text-2xl font-semibold text-foreground">{file.path}</h1>
      </div>
      <div className="flex-1 px-8 pb-8 overflow-y-auto overflow-x-hidden">
        <textarea
          ref={textareaRef}
          value={file.content}
          onChange={handleChange}
          className="w-full h-full min-h-full bg-transparent text-foreground text-base leading-relaxed resize-none focus:outline-none placeholder:text-muted-foreground font-sans break-words whitespace-pre-wrap overflow-hidden"
          placeholder="Start writing..."
          spellCheck={false}
          style={{ wordBreak: "break-word", overflowWrap: "break-word" }}
        />
      </div>
    </div>
  );
}
