import React from "react";

export interface TabContentProps {
  filePath: string;
  isActive: boolean;
}

export type TabContentComponent = React.ComponentType<TabContentProps>;

/**
 * Base TabContent component that serves as a wrapper for tab content
 * This provides a consistent interface for all tab content types
 */
export interface TabContentWrapperProps extends TabContentProps {
  children: React.ReactNode;
  className?: string;
}

export const TabContentWrapper: React.FC<TabContentWrapperProps> = ({
  isActive,
  children,
  className = "",
}) => {
  return (
    <div
      className={`
        flex flex-col bg-background overflow-hidden absolute inset-0 transition-opacity duration-200
        ${isActive ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none"}
        ${className}
      `.trim()}
    >
      {children}
    </div>
  );
};
