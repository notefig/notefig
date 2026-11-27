import { BUILT_IN_HARNESSES, type HarnessDefinition } from "@notefig/shared/agent";

/**
 * Whether this build runs the scripted mock harness instead of real agents
 * (`VITE_AGENT_MOCK=1`, the e2e builds). A leaf, so the gates that check it
 * import nothing of the harness itself.
 */
export const MOCK_AGENT_MODE = import.meta.env.VITE_AGENT_MOCK === "1";

/**
 * The mock harness, offered next to the real ones in a dev build: a session
 * on it talks to the scripted agent (./mock-harness.ts), and its commands
 * (`/error`, `/crash`…) make it misbehave on cue. Its command spawns
 * nothing; the transport is the mock's whenever the harness is this one.
 */
export const MOCK_HARNESS: HarnessDefinition = {
  id: "mock",
  label: "Mock",
  command: "mock:",
  args: [],
  env: {},
  // Always "installed": there is nothing to look for.
  probeCommand: "printf mock",
  // Claude's way, so its usage and limits read the way Claude's do.
  mcpRegistration: "session-new",
};

/** Whether this build offers the mock harness: a dev or e2e build, never a
 *  release (Vite folds this to false, and the mock drops out of it), nor a
 *  unit test run, which checks the harnesses a release ships. */
export const MOCK_HARNESS_OFFERED =
  (import.meta.env.DEV && import.meta.env.MODE !== "test") || MOCK_AGENT_MODE;

/** The harnesses this build ships: the built-ins, and the mock where it is
 *  offered. */
export const APP_BUILT_IN_HARNESSES: readonly HarnessDefinition[] =
  MOCK_HARNESS_OFFERED ? [...BUILT_IN_HARNESSES, MOCK_HARNESS] : BUILT_IN_HARNESSES;

/** Whether a session on this harness talks to the scripted agent: every
 *  session in a mock build, a mock-harness one in a dev build. */
export function talksToMock(harness: Pick<HarnessDefinition, "id">): boolean {
  return MOCK_AGENT_MODE || (MOCK_HARNESS_OFFERED && harness.id === MOCK_HARNESS.id);
}
