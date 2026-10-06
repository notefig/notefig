/**
 * Entering a workspace lands somewhere to read (MET-135's empty entry):
 * when none of its files is open in the dock, its most recent scratchpad,
 * or a fresh one, opens as a tab. Either way the entry sweep runs:
 * abandoned empty scratchpads go, never one open as a tab.
 *
 * Only on `workspace:entered` — the user choosing the workspace. A restore
 * at boot never lands one over the saved layout, and a `focus` (the
 * switcher bringing it forward) leaves the dock as it is.
 */
import { defineModule } from "@notefig/core";
import type { LayoutApi } from "./layout";
import { isFileTabId } from "./tabs";
import type { WorkspaceRegistry } from "./workspaces";
import { workspaceKey } from "@/utils/path";

declare module "@notefig/core" {
  interface CoreModules {
    "scratchpad-landing": undefined;
  }
}

/** Whether any file tab in the dock belongs to the workspace. */
function hasOpenFileTab(
  layout: LayoutApi,
  registry: WorkspaceRegistry,
  workspacePath: string,
): boolean {
  const key = workspaceKey(workspacePath);
  return layout.openTabIds().some((tabId) => {
    if (!isFileTabId(tabId)) return false;
    const owner = registry.workspaceOf(tabId);
    return owner !== null && workspaceKey(owner) === key;
  });
}

export const scratchpadLandingModule = defineModule({
  name: "scratchpad-landing",
  // The registry's focus handler runs first: the workspace is in the open
  // set, its collections seeded, before anything lands in it.
  needs: ["layout", "tabs", "workspaceRegistry"],
  boot: (_api, ctx) => {
    const layout = ctx.use("layout");
    const tabs = ctx.use("tabs");
    const registry = ctx.use("workspaceRegistry");
    return ctx.hooks.on("workspace:entered", async ({ path }) => {
      // Closed while the focus steps before this one ran: nowhere to land.
      const workspace = ctx.workspaceHandle(path);
      if (!workspace.isOpen()) return;
      const { scratchpads } = workspace;
      if (hasOpenFileTab(layout, registry, path)) {
        await scratchpads.sweep(layout.openTabIds());
        return;
      }
      const scratchpad = await scratchpads.enter(layout.openTabIds());
      if (scratchpad !== null) tabs.open(scratchpad, { intent: "new-tab" });
    });
  },
});
