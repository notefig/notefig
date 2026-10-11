/**
 * `core.harnesses` for tests, over a real KV store. Its shell refuses to
 * run, as the browser adapter's does — every install check comes back
 * "couldn't check" — unless the test hands its own.
 */
import { createHarnesses, type HarnessesApi } from "@/modules/agents/harnesses";
import type { Proc } from "@/modules/agents/harness-discovery";
import type { KvApi } from "@/modules/kv";
import { testKv } from "./test-kv";

const NO_SHELL: Proc = {
  runShellCommand: () =>
    Promise.reject(new Error("Shell commands are not supported in this test.")),
};

export function testHarnesses({
  kv = testKv(),
  proc = NO_SHELL,
}: { kv?: KvApi; proc?: Proc } = {}): HarnessesApi {
  return createHarnesses({ kv, proc });
}
