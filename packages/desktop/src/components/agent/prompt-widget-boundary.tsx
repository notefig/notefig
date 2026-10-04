/**
 * Installs the prompt widget's host for everything rendered below it.
 *
 * A component rather than a call in the workspace shell because the host is
 * built from hooks (core, the default harness) that must run inside the
 * tree. Everything the widget renders in (document node views, which
 * portal into this tree, and the agent chat tab's composer) sits
 * underneath.
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
