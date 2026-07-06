import { AbstractCommand } from './abstract.command';
import type { Command } from 'commander';

/**
 * `metrists agent` — the CLI worker that gives the Metrists web app access
 * to AI harnesses on this machine.
 *
 * Deliberately thin — four responsibilities, zero protocol awareness
 * (see docs/architecture/agent-harness.md and packages/relay/PROTOCOL.md):
 * 1. Connect to the relay, generate a pairing secret, print the pairing code,
 *    complete the challenge/ack handshake.
 * 2. Supervise adapter processes: ctl start-task spawns one per taskId,
 *    stop-task kills, exits become task-exit events (task-supervisor.ts).
 * 3. Pump bytes: each process's stdio lines ↔ "acp" frames tagged with its
 *    taskId. Never parses a JSON-RPC line (the app advertises fs:false in
 *    web mode, so no client-side fs methods exist to answer here).
 * 4. Watch --dir with chokidar and publish changes on the "watch" channel.
 */
export class AgentCommand extends AbstractCommand {
  public load(program: Command) {
    return program
      .command('agent')
      .description(
        'Run the local agent worker so the Metrists web app can use AI harnesses on this machine',
      )
      .option('--relay <url>', 'relay server URL (any PROTOCOL.md-compliant server)')
      .option('--dir <path>', 'workspace folder the agent operates on', '.');
  }

  public async handle(_command: Command) {
    // TODO(phase 3): wire lib/relay-client/{connection,task-supervisor}.
    // Harness selection arrives per-task from the app (ctl start-task).
    this.logger.error('metrists agent is not implemented yet');
    process.exit(1);
  }
}
