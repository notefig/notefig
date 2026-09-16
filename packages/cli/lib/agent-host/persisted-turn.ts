/**
 * A headless turn that leaves a task row behind, in the app's own shape.
 *
 * The row is what makes a CLI run part of the app rather than beside it: it
 * appears in the app's task list while it runs, and afterwards the app can
 * resume the session. Its lifecycle mirrors what the app would write, with one
 * addition and one hand-back:
 *
 *   before the harness runs  inserted as "starting", owned by this pid
 *   session accepted         "running", with the session id that makes it
 *                            resumable
 *   turn over (any outcome)  replaced by exactly the row the app's boot
 *                            mapping produces — "restored", no owner — or
 *                            deleted if no session was ever accepted
 *
 * `ownerPid` is what stops the app from demoting the row while this process
 * is still driving it. If the process dies before the hand-back, the pid is
 * gone and the app's next boot restores the row like any other.
 *
 * Persistence never decides the turn. A write that fails is reported and the
 * agent carries on; the only thing lost is the row.
 */
import {
  HARNESS_CUSTOM_KEY,
  HARNESS_OVERRIDES_KEY,
  HARNESS_SETTINGS_NAMESPACE,
  bootAgentTaskRow,
  parseCustomHarnessEntries,
  parseHarnessOverrides,
  taskTitleFromPrompt,
  type AgentTaskRow,
  type SharedDb,
} from '../shared';
import {
  findHarness,
  runHeadlessTurn,
  type HeadlessSessionSpec,
  type TurnOutcome,
} from './headless-session';

export type PersistedTurnSpec = HeadlessSessionSpec & {
  /** The app's database, or null to run without leaving a row. */
  db: SharedDb | null;
  /** A persistence problem the user should hear about; never fatal. */
  onPersistenceWarning?: (message: string) => void;
};

export async function runPersistedHeadlessTurn(
  spec: PersistedTurnSpec,
): Promise<TurnOutcome> {
  const { db } = spec;
  const warn = (message: string) => spec.onPersistenceWarning?.(message);
  const write = async (what: string, run: () => Promise<void>) => {
    if (!db) return;
    try {
      await run();
    } catch (error: any) {
      warn(`could not ${what}: ${error?.message ?? error}`);
    }
  };

  // The same harness settings the app's settings screen wrote.
  let harnessSettings = spec.harnessSettings;
  if (db && !harnessSettings) {
    try {
      const [overrides, custom] = await Promise.all([
        db.readKv<unknown>(HARNESS_SETTINGS_NAMESPACE, HARNESS_OVERRIDES_KEY),
        db.readKv<unknown>(HARNESS_SETTINGS_NAMESPACE, HARNESS_CUSTOM_KEY),
      ]);
      harnessSettings = {
        overrides: parseHarnessOverrides(overrides),
        custom: parseCustomHarnessEntries(custom),
      };
    } catch (error: any) {
      warn(`could not read harness settings: ${error?.message ?? error}`);
    }
  }

  // Resolve first: an unknown or disabled harness must not leave a row.
  findHarness(spec.harnessId, harnessSettings);

  const now = Date.now();
  let row: AgentTaskRow = {
    taskId: spec.taskId,
    workspacePath: spec.workspacePath,
    title: taskTitleFromPrompt(spec.prompt),
    status: 'starting',
    harnessId: spec.harnessId,
    createdAt: now,
    updatedAt: now,
    ownerPid: process.pid,
  };
  await write('record the task', () => db!.tasks.insert(row));

  try {
    return await runHeadlessTurn({
      ...spec,
      harnessSettings,
      onSessionReady: async (sessionId) => {
        row = { ...row, sessionId, status: 'running', updatedAt: Date.now() };
        await write('record the session', () =>
          db!.tasks.update(spec.taskId, {
            sessionId,
            status: 'running',
            updatedAt: row.updatedAt,
          }),
        );
        await spec.onSessionReady?.(sessionId);
      },
    });
  } finally {
    const handedBack = bootAgentTaskRow({ ...row, updatedAt: Date.now() });
    await write('hand the task back to the app', () =>
      handedBack
        ? db!.tasks.replace(handedBack)
        : db!.tasks.delete(spec.taskId),
    );
  }
}
