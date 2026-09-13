/**
 * The Node implementation of `CoreProcess`.
 *
 * `createAgentTransport` is the existing node transport, unchanged — this
 * only puts it behind the surface the core asks through. The other two are
 * declared-unavailable rather than absent: app-tools MCP is not part of the
 * headless host yet (MET-182 scoped it out), and shell probing belongs to
 * harness discovery, which has not moved.
 */
import { spawn } from 'child_process';
import type { CoreProcess } from '../core';
import { createNodeAgentTransport } from './node-agent-transport';

function unsupported(member: string): never {
  throw new Error(
    `${member} is not implemented by the Node process surface yet (MET-183).`,
  );
}

export function createNodeProcess(): CoreProcess {
  return {
    createAgentTransport: ({ harness, workspacePath }) =>
      createNodeAgentTransport({ harness, workspacePath }),

    createMcpEndpoint: () => unsupported('createMcpEndpoint'),

    runShellCommand: (script) =>
      new Promise((resolve, reject) => {
        const shell = process.env.SHELL ?? '/bin/sh';
        const child = spawn(shell, ['-lc', script], { stdio: 'pipe' });
        let stdout = '';
        child.stdout.on('data', (chunk) => (stdout += String(chunk)));
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, exitCode: code ?? 0 }));
      }),
  };
}
