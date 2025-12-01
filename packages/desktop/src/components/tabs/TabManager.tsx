import React from "react";
import { Icons } from "@/components/icons";
import { useFileManager } from "@/hooks/useFileManager";
import { TabContentComponent } from "./TabContent";
import { isMarkdownFile } from "./content-types";
import { MarkdownEditorContent } from "./MarkdownEditorContent";

/**
 * Determines which TabContent component to use based on the file type
 * Currently only supports markdown files - architecture ready for other types
 */
function getContentComponent(filePath: string): TabContentComponent {
  if (isMarkdownFile(filePath)) {
    return MarkdownEditorContent;
  } else {
    // For now, use markdown editor for all files
    // TODO: Add other content types as needed
    return MarkdownEditorContent;
  }
}

export const TabManager: React.FC = () => {
  const { tabs, activeTabIndex } = useFileManager();

  if (tabs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <Icons.folder className="h-16 w-16 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">No File Selected</h3>
          <p className="text-sm text-muted-foreground">
            Select a file from the explorer to start editing
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden relative">
      {tabs.map((tab, index) => {
        const ContentComponent = getContentComponent(tab.filePath);
        return (
          <ContentComponent
            key={`${tab.filePath}-${index}`} // Ensure unique keys for each tab instance
            filePath={tab.filePath}
            isActive={index === activeTabIndex}
          />
        );
      })}
    </div>
  );
};
