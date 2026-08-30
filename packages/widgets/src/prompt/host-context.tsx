/**
 * The React half of the host hand-off. The ProseMirror half gets the same
 * object through the node's extension options; this context is what carries
 * it to the widget chrome, which mounts inside a node view several React
 * trees away from wherever the app rendered the editor.
 *
 * No default value on purpose: a widget rendered outside the provider is a
 * wiring bug, and a silently-empty host would surface as a dead Send button
 * instead of an error.
 */
import { createContext, useContext, type ReactNode } from "react";
import type { PromptWidgetHost } from "./host";

const HostContext = createContext<PromptWidgetHost | null>(null);

export function PromptWidgetHostProvider({
  host,
  children,
}: {
  host: PromptWidgetHost;
  children: ReactNode;
}) {
  return <HostContext.Provider value={host}>{children}</HostContext.Provider>;
}

export function usePromptWidgetHost(): PromptWidgetHost {
  const host = useContext(HostContext);
  if (!host) {
    throw new Error(
      "Prompt widget rendered outside <PromptWidgetHostProvider> — the editor's host was never installed.",
    );
  }
  return host;
}
