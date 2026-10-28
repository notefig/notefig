/**
 * Diff blocks (```ts diff) draw themselves wherever the page holds one —
 * documents, chat replies, an agent's edits in its transcript — once their
 * element is defined (@notefig/widgets/diff-block/element), with what only
 * the app knows: which workspace file a block's path names, and how to
 * open it.
 */
import { defineModule } from "@notefig/core";
import { defineDiffBlockElement, type DiffBlockHost } from "@notefig/widgets/diff-block/element";
import type { DiffFile } from "@notefig/widgets/diff-block/card";
import { tabsModule } from "@/modules/tabs";
import { workspacesModule } from "@/modules/workspaces";
import { path as pathutil, relativeTreePath } from "@/utils/path";

export const diffBlocksModule = defineModule({
  name: "diff-blocks",
  needs: [tabsModule, workspacesModule],
  boot: (_api, ctx) => {
    const tabs = ctx.use("tabs");
    const registry = ctx.use("workspaceRegistry");
    const host: DiffBlockHost = {
      resolveFile(workspacePath, path): DiffFile {
        const native = pathutil.fromTreePath(path);
        const absolute = pathutil.isAbsolute(native)
          ? native
          : workspacePath && pathutil.join(workspacePath, native);
        const workspace = absolute ? registry.workspaceOf(absolute) : null;
        if (!absolute || !workspace) return { label: path };
        const label = relativeTreePath(workspace, absolute) ?? path;
        const row = ctx.workspaceHandle(workspace).files.collections.metadata.get(absolute);
        if (row?.type !== "file") return { label };
        return { label, open: () => void tabs.open(absolute, { intent: "new-tab" }) };
      },
    };
    defineDiffBlockElement(host);
  },
});
