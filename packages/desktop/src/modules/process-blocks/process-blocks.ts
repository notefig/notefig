/**
 * Every process block's state, as a core module: `core.processBlocks`.
 *
 * The service is the widget package's (`createProcessBlocks`), as the
 * prompt widgets' is (../prompt-widgets); this module builds it over the
 * platform's process spawn. The editor hands it to its widgets
 * (editor-store.ts).
 */
import { createProcessBlocks, type ProcessBlocksApi } from "@notefig/widgets";
import { defineModule } from "@notefig/core";
import { platformModule } from "@/core/services";

declare module "@notefig/core" {
  interface CoreModules {
    processBlocks: ProcessBlocksApi;
  }
}

export const processBlocksModule = defineModule({
  name: "processBlocks",
  needs: [platformModule],
  register: (ctx) => {
    const { proc } = ctx.use("platform");
    return createProcessBlocks({ spawn: (spec) => proc.spawnProcess(spec) });
  },
});
