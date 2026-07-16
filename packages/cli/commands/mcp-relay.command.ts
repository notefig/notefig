import * as net from 'net';
import type { Command } from 'commander';
import { AbstractCommand } from './abstract.command';

/**
 * Hidden stdio↔TCP relay — the "binary" a harness spawns to reach the app's
 * MCP server (the Node analogue of the desktop's --mcp-stdio-relay mode).
 * Connects to the worker's per-task loopback listener, presents
 * METRISTS_MCP_TOKEN as its first line, then pumps stdin→socket and
 * socket→stdout untouched. Zero protocol awareness; stdout is the MCP
 * channel, so nothing else may ever print to it.
 */
export class McpRelayCommand extends AbstractCommand {
  public load(program: Command) {
    return program
      .command('mcp-relay', { hidden: true })
      .description('internal: stdio relay for harness MCP connections')
      .requiredOption('--port <port>', 'loopback port of the MCP listener');
  }

  public async handle(command: Command) {
    const port = Number(command.opts().port);
    const token = process.env.METRISTS_MCP_TOKEN;
    if (!token) {
      process.stderr.write('METRISTS_MCP_TOKEN is not set\n');
      process.exit(1);
    }

    const socket = net.connect(port, '127.0.0.1');
    socket.on('connect', () => {
      socket.write(`${token}\n`);
      process.stdin.pipe(socket);
      socket.pipe(process.stdout);
    });
    const exit = () => process.exit(0);
    socket.on('close', exit);
    socket.on('error', (error) => {
      process.stderr.write(`mcp-relay: ${error.message}\n`);
      process.exit(1);
    });
    process.stdin.on('end', () => socket.end());

    // Keep the process alive until the socket closes.
    await new Promise<void>(() => undefined);
  }
}
