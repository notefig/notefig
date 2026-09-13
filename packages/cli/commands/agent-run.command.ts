import * as path from 'path';
import { promises as fs } from 'fs';
import * as chalk from 'chalk';
import { AbstractCommand } from './abstract.command';
import {
  HeadlessSessionError,
  runHeadlessTurn,
} from '../lib/agent-host/headless-session';
import { renderSessionUpdate } from '../lib/agent-host/render-session-update';
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
function installCancellation(): {
  signal: AbortSignal;
  cancelled: () => boolean;
  dispose: () => void;
} {
  const controller = new AbortController();
  let cancelled = false;
  const onSignal = () => {
    if (cancelled) {
      console.log(chalk.gray('\n  Forcing exit.'));
      process.exit(EXIT_CANCELLED);
    }
    cancelled = true;
    console.log(chalk.gray('\n  Cancelling... (Ctrl-C again to force)'));
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
 * Note what it does NOT do: no workspace registry, no collections, no
 * persistence, no MCP app tools. One command, one session, streamed output.
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
      .requiredOption('--prompt <text>', 'the prompt to send')
      .option('--verbose', 'also print adapter stderr');
  }

  public async handle(command: Command) {
    const options = command.opts();
    const workspacePath = await this.resolveWorkspace(options.dir ?? '.');
    const cancellation = installCancellation();

    console.log(
      chalk.gray(
        `  ${options.harness} · ${workspacePath}\n  (unstable internal command — see MET-184 for the supported surface)\n`,
      ),
    );

    try {
      const outcome = await runHeadlessTurn({
        harnessId: options.harness,
        workspacePath,
        prompt: options.prompt,
        onUpdate: (notification) => renderSessionUpdate(notification),
        onDiagnostic: (line) => {
          if (options.verbose) console.error(chalk.gray(`  [stderr] ${line}`));
        },
        signal: cancellation.signal,
      });
      // A harness that honoured the protocol cancel ends the turn itself, so
      // a normal return can still mean "cancelled".
      if (cancellation.cancelled()) {
        console.log(chalk.gray(`\n  Cancelled (${outcome.stopReason}).`));
        process.exitCode = EXIT_CANCELLED;
        return;
      }
      console.log(chalk.gray(`\n  Turn ended: ${outcome.stopReason}`));
    } catch (error: any) {
      this.reportFailure(error, cancellation.cancelled());
    } finally {
      cancellation.dispose();
    }
  }

  private reportFailure(error: any, cancelled: boolean): void {
    if (cancelled) {
      // A harness that ignored the cancel was killed by our own teardown —
      // the expected end of a cancelled run, not a failure.
      console.log(chalk.gray('  Cancelled.'));
      process.exitCode = EXIT_CANCELLED;
      return;
    }
    const message =
      error instanceof HeadlessSessionError
        ? error.message
        : (error?.message ?? String(error));
    console.error(chalk.red(`\n  Failed: ${message}`));
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
