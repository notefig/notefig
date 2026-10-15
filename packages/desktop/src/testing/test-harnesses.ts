/**
 * `core.harnesses` for tests, over an in-memory database of its own (the
 * rows, and the KV an older version kept settings in) unless the test
 * hands one — the same one twice is a relaunch. Its shell refuses to run,
 * as the browser adapter's does — every install check comes back
 * "couldn't check" — unless the test hands its own. Sessions announce on
 * hooks of its own unless the test hands the ones it emits on.
 */
import { createHooks, type Hooks } from "@notefig/core";
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
  hooks = createHooks(),
}: {
  db?: ReturnType<typeof createNodeTestDb>;
  kv?: KvApi;
  proc?: Proc;
  hooks?: Pick<Hooks, "on">;
} = {}): HarnessesApi {
  return createHarnesses({ persistence: db.get(), kv, proc, hooks });
}
