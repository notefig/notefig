/**
 * Every process block's state, as a core module: `core.processBlocks`.
 *
 * The service is the widget package's (`createProcessBlocks`), as the
 * prompt widgets' is (../prompt-widgets); this module builds it over the
 * platform's process spawn and owns what it reads: the registry of blocks
 * the app has started, kept in KV by id, so a block still runs its command
 * after a relaunch and a file can't hand one in. The editor hands the
 * service to its widgets (editor-store.ts); an agent starts a block through
 * `start` (the `process_start` tool).
 */
import {
  createProcessBlocks,
  processBlobId,
  type ProcessBlocksApi,
  type RegisteredProcess,
} from "@notefig/widgets";
import { defineModule } from "@notefig/core";
import { platformModule } from "@/core/services";
import { kvModule } from "@/modules/kv";

/** A registration, with who asked and when. */
type ProcessRow = RegisteredProcess & { taskId: string; createdAt: number };

export interface ProcessBlocksModuleApi extends ProcessBlocksApi {
  /** The folder a block runs in, which says whose it is; undefined for an
   *  id the app never minted. */
  cwdOf(blobId: string): string | undefined;
  /** Register a block for the command and run it; resolves to its id once
   *  the registration is durable, so a marker can't outrun it. */
  start(spec: {
    command: string;
    cwd: string;
    taskId: string;
  }): Promise<string>;
}

declare module "@notefig/core" {
  interface CoreModules {
    processBlocks: ProcessBlocksModuleApi;
  }
}

const NAMESPACE = "process-blocks";

/** A process id (`proc_<base36>`), which the marker's charset admits. */
const newProcId = () =>
  `proc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export const processBlocksModule = defineModule({
  name: "processBlocks",
  needs: [platformModule, kvModule],
  register: (ctx) => {
    const { proc } = ctx.use("platform");
    const kv = ctx.use("kv");
    const row = (blobId: string) =>
      kv.collection(NAMESPACE).get(blobId)?.value as ProcessRow | undefined;
    const blocks = createProcessBlocks({
      spawn: (spec) => proc.spawnProcess(spec),
      registry: { load: () => kv.collection(NAMESPACE).preload(), get: row },
    });
    return {
      ...blocks,
      cwdOf: (blobId) => row(blobId)?.cwd,
      async start({ command, cwd, taskId }) {
        const blobId = processBlobId(newProcId());
        const row: ProcessRow = { command, cwd, taskId, createdAt: Date.now() };
        await kv.write(NAMESPACE, blobId, row);
        await blocks.loaded();
        blocks.run(blobId);
        return blobId;
      },
    };
  },
});
