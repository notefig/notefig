/**
 * Installs the prompt widget's host for everything rendered below it.
 *
 * A component rather than a call at the WorkspaceTabsProvider site because
 * the host is built from hooks that need that provider above them — this is
 * the child that can read it. Everything the widget renders in (document
 * node views, which portal into this tree, and the agent chat tab's
 * composer) sits underneath.
 */
import type { ReactNode } from "react";
import { PromptWidgetHostProvider } from "@notefig/widgets";
import { usePromptWidgetHost } from "./prompt-widget-host";

export function PromptWidgetBoundary({ children }: { children: ReactNode }) {
  return (
    <PromptWidgetHostProvider host={usePromptWidgetHost()}>
      {children}
    </PromptWidgetHostProvider>
  );
}
