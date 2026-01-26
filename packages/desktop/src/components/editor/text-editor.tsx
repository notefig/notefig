"use client";

import React from "react";
import { useCallback, useEffect, useRef } from "react";

interface TextEditorProps {
  content: string;
  onChange: (content: string) => void;
  title?: string;
}

export function TextEditor({ content, onChange, title }: TextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value);
    },
    [onChange]
  );

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  }, []);

  return (
    <div className="flex flex-col h-full w-full bg-background overflow-hidden">
      {title && (
        <div className="flex items-center justify-center py-6 shrink-0">
          <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        </div>
      )}
      <div className="flex-1 px-8 pb-8 overflow-y-auto overflow-x-hidden">
        <textarea
          ref={textareaRef}
          value={content}
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
