import * as path from 'path';
import { promises as fs } from 'fs';
import { newTaskId, type SharedDb } from '../lib/shared';
import { AbstractCommand } from './abstract.command';
import { HeadlessSessionError } from '../lib/agent-host/headless-session';
import { openAppDb, type OpenAppDbResult } from '../lib/agent-host/app-db';
import { runPersistedHeadlessTurn } from '../lib/agent-host/persisted-turn';
import { renderSessionUpdate } from '../lib/agent-host/render-session-update';
import type { Logger } from '../lib/utils/logger.util';
import type { Command } from 'commander';

/** 128 + SIGINT, the shell convention for "interrupted". */
const EXIT_CANCELLED = 130;

/**
 * Ctrl-C has to drive teardown, not just print. Handling the signal replaces
 * Node's default "die now", so an abort must actually reach the turn: without
 * it the run stays parked on `prompt()`, teardown never happens, and the
 * harness tree outlives the CLI (observed against a real harness). A second
 * signal is the escape hatch if a harness wedges.
 */
function installCancellation(logger: Logger): {
  signal: AbortSignal;
  cancelled: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let cancelled = false;
  const onSignal = () => {
    if (cancelled) {
      logger.info('\n  Forcing exit.');
      process.exit(EXIT_CANCELLED);
    }
    cancelled = true;
    logger.info('\n  Cancelling... (Ctrl-C again to force)');
    controller.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return {
    signal: controller.signal,
    cancelled: () => cancelled,
    dispose: () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    },
  };
}

/**
 * `notefig agent-run` — run one agent turn in a workspace, headlessly.
 *
 * HIDDEN AND UNSTABLE ON PURPOSE. This is a proof, not a product surface:
 * it exists to demonstrate that the orchestration layer runs outside the
 * webview, which is the question the whole service rearchitecture is gated
 * on (MET-182). The real, supported command vocabulary is designed from the
 * domain in MET-184, and `agent run` there supersedes this with an output
 * contract and exit-code contract. Do not build on this.
 *
 * The run is a task in the app's own database: it shows in the app while it
 * runs, reads the harness settings the app's settings screen wrote, and hands
 * the task back resumable when the turn ends (see persisted-turn.ts). What it
 * still does NOT do: no workspace registry, no transcript rows, no MCP app
 * tools. One command, one session, streamed output.
 *
 * The task id is minted with the same `newTaskId()` the desktop uses, so the
 * row is indistinguishable from one the app created.
 * Streamed agent output goes straight to stdout (it is the command's
 * product); everything the command says *about* the run goes through the
 * shared logger, so `--verbose` behaves as it does everywhere else.
 */
export class AgentRunCommand extends AbstractCommand {
  public load(program: Command) {
    return program
      .command('agent-run', { hidden: true })
      .description(
        '(unstable, internal) Run a single agent turn headlessly and stream its output',
      )
      .requiredOption('--harness <id>', 'harness to run (e.g. claude-code)')
      .option('--dir <path>', 'workspace folder the agent operates on', '.')
      .requiredOption('--prompt <text>', 'the prompt to send');
  }

  public async handle(command: Command) {
    const options = command.opts();
    const workspacePath = await this.resolveWorkspace(options.dir ?? '.');
    const cancellation = installCancellation(this.logger);
    const taskId = newTaskId();

    this.logger.info(
      `  ${options.harness} · ${workspacePath}\n  task ${taskId}\n  (unstable internal command — see MET-184 for the supported surface)\n`,
    );

    const opened = openAppDb();
    // Explicit narrowing: this package compiles with `strict: false`, where
    // the `ok` discriminant does not narrow the union by itself.
    let db: SharedDb | null = null;
    if (opened.ok === true) {
      db = (opened as Extract<OpenAppDbResult, { ok: true }>).db;
    } else {
      const failed = opened as Extract<OpenAppDbResult, { ok: false }>;
      this.logger.info(
        `  (not recording this run in the app: could not open ${failed.path}: ${failed.error})\n`,
      );
    }

    try {
      const outcome = await runPersistedHeadlessTurn({
        db,
        onPersistenceWarning: (message) =>
          this.logger.info(`  (app database: ${message})`),
        taskId,
        harnessId: options.harness,
        workspacePath,
        prompt: options.prompt,
        onUpdate: (notification) => renderSessionUpdate(notification),
        // Adapter stderr is diagnostic, so it is verbose-only by virtue of
        // the level, not a hand-rolled flag check.
        onDiagnostic: (line) => this.logger.verbose(`  [stderr] ${line}`),
        signal: cancellation.signal,
      });
      // A harness that honoured the protocol cancel ends the turn itself, so
      // a normal return can still mean "cancelled".
      if (cancellation.cancelled()) {
        this.logger.info(`\n  Cancelled (${outcome.stopReason}).`);
        process.exitCode = EXIT_CANCELLED;
        return;
      }
      this.logger.info(`\n  Turn ended: ${outcome.stopReason}`);
    } catch (error: any) {
      this.reportFailure(error, cancellation.cancelled());
    } finally {
      cancellation.dispose();
      await db?.close();
    }
  }

  private reportFailure(error: any, cancelled: boolean): void {
    if (cancelled) {
      // A harness that ignored the cancel was killed by our own teardown —
      // the expected end of a cancelled run, not a failure.
      this.logger.info('  Cancelled.');
      process.exitCode = EXIT_CANCELLED;
      return;
    }
    const message =
      error instanceof HeadlessSessionError
        ? error.message
        : (error?.message ?? String(error));
    this.logger.error(`\n  Failed: ${message}`);
    process.exitCode = 1;
  }

  private async resolveWorkspace(dir: string): Promise<string> {
    const resolved = path.resolve(dir);
    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      this.logger.error(`Workspace folder does not exist: ${resolved}`);
      process.exit(1);
    }
    if (!stat.isDirectory()) {
      this.logger.error(`Not a directory: ${resolved}`);
      process.exit(1);
    }
    return await fs.realpath(resolved);
  }
}
