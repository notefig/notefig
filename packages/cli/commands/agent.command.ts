import { AbstractCommand } from './abstract.command';
import type { Command } from 'commander';

/**
 * `metrists agent` — the CLI worker that gives the Metrists web app access
 * to AI harnesses on this machine.
 *
 * Flow (see docs/architecture/agent-harness.md and packages/relay/PROTOCOL.md):
 * 1. Connect to the relay, generate a pairing secret, print the pairing code.
 * 2. On peer-joined + challenge/ack, spawn the configured ACP harness adapter
 *    in --dir and pipe its stdio through the encrypted tunnel ("acp" channel).
 * 3. Intercept fs/* and terminal/* ACP client-methods and serve them locally
 *    (bytes stay on this machine); forward session/request_permission and
 *    session/update to the browser.
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
      .option('--dir <path>', 'workspace folder the agent operates on', '.')
      .option('--harness <id>', 'harness to spawn (see built-in list)', 'claude-code');
  }

  public async handle(_command: Command) {
    // TODO(phase 3): wire lib/relay-client/{connection,harness-spawn,fs-interceptor}.
    this.logger.error('metrists agent is not implemented yet');
    process.exit(1);
  }
}
