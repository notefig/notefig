/**
 * `core.harnesses` for tests, over an in-memory database of its own (the
 * rows, and the KV an older version kept settings in) unless the test
 * hands one — the same one twice is a relaunch. Its shell refuses to run,
 * as the browser adapter's does — every install check comes back
 * "couldn't check" — unless the test hands its own.
 */
import { createHarnesses, type HarnessesApi } from "@/modules/agents/harnesses";
import type { Proc } from "@/modules/agents/harness-discovery";
import { createKv, type KvApi } from "@/modules/kv";
import { createNodeTestDb } from "./node-db";

const NO_SHELL: Proc = {
  runShellCommand: () =>
    Promise.reject(new Error("Shell commands are not supported in this test.")),
};

export function testHarnesses({
  db = createNodeTestDb(),
  kv = createKv(() => db.get()),
  proc = NO_SHELL,
}: {
  db?: ReturnType<typeof createNodeTestDb>;
  kv?: KvApi;
  proc?: Proc;
} = {}): HarnessesApi {
  return createHarnesses({ persistence: db.get(), kv, proc });
}
