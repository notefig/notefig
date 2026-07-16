import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as chalk from 'chalk';
import * as qrcode from 'qrcode-terminal';
import {
  encodePairingCode,
  generatePairingSecret,
  pairingLink,
  BUILT_IN_HARNESSES,
  type HarnessAdvert,
} from '@metrists/shared';
import { AbstractCommand } from './abstract.command';
import { AgentWorker, probeHarnesses } from '../lib/agent-worker';
import type { Command } from 'commander';

/**
 * `metrists agent` — the CLI worker that gives the Metrists web app access
 * to AI harnesses on this machine.
 *
 * The worker itself is a single file (../lib/agent-worker.ts) and does one
 * thing: pump bytes between a paired browser and locally-spawned agent
 * processes (ACP stdio + MCP loopback), never parsing a protocol line. This
 * command is just its shell: resolve --dir, probe harnesses, print the
 * pairing code, and run until Ctrl-C. Files never cross the wire — the
 * browser's own fs adapter owns them (same-machine model).
 *
 * By default the browser connects straight to ws://127.0.0.1:<port>
 * (loopback is exempt from mixed-content). `--tunnel-url` points the pairing
 * at any wss:// endpoint instead (ngrok / Tailscale Funnel / your own proxy)
 * for remote access; frames are end-to-end encrypted either way, so the
 * tunnel is a dumb pipe.
 */
export class AgentCommand extends AbstractCommand {
  public load(program: Command) {
    return program
      .command('agent')
      .description(
        'Run the local agent worker so the Metrists web app can use AI harnesses on this machine',
      )
      .option('--dir <path>', 'workspace folder the agent operates on', '.')
      .option('--port <port>', 'local WebSocket port (default: ephemeral)')
      .option(
        '--tunnel-url <url>',
        'pair against this wss:// endpoint instead of ws://127.0.0.1 (ngrok, Tailscale Funnel, your own proxy)',
      );
  }

  public async handle(command: Command) {
    const options = command.opts();
    const workspacePath = await this.resolveWorkspace(options.dir ?? '.');

    this.logger.info('Probing installed harnesses...');
    const harnesses = await probeHarnesses();

    const secret = generatePairingSecret();
    const worker = new AgentWorker({
      secret,
      workspacePath,
      workerName: os.hostname(),
      harnesses,
      logger: this.logger,
      port: options.port ? Number(options.port) : 0,
    });
    const port = await worker.start();
    this.logger.info(`Worker listening on 127.0.0.1:${port}`);

    const url = options.tunnelUrl ?? `ws://127.0.0.1:${port}`;
    this.printPairing(secret, url, workspacePath, harnesses);

    await new Promise<void>((resolve) => {
      const shutdown = async () => {
        this.logger.info('Shutting down...');
        await worker.stop();
        resolve();
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    });
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

  private printPairing(
    secret: Uint8Array,
    url: string,
    workspacePath: string,
    harnesses: HarnessAdvert[],
  ): void {
    const code = encodePairingCode(secret, url);
    const links = pairingLink(code);
    const harnessLines = harnesses
      .map((advert) => {
        const label =
          BUILT_IN_HARNESSES.find((h) => h.id === advert.id)?.label ??
          advert.id;
        return advert.available
          ? `  ${chalk.green('✓')} ${label}`
          : `  ${chalk.gray(`✗ ${label} (not installed)`)}`;
      })
      .join('\n');

    console.log('');
    console.log(chalk.bold('  Pair the Metrists web app with this machine'));
    console.log('');
    qrcode.generate(links.web, { small: true }, (qr: string) => {
      console.log(qr);
    });
    console.log(`  ${chalk.bold('Link:')} ${chalk.cyan(links.web)}`);
    console.log(`  ${chalk.bold('Code:')} ${code}`);
    console.log('');
    console.log(`  ${chalk.bold('Workspace:')} ${workspacePath}`);
    console.log(harnessLines);
    console.log('');
    console.log(
      chalk.gray(
        '  The code never reaches any server — it rides the link fragment. Ctrl-C to stop.',
      ),
    );
    console.log('');
  }
}
