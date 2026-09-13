/**
 * The packaging guard. @notefig/agent's own exports point at ESM TypeScript
 * source, and its ACP dependency is ESM-only, so the only form the published
 * CLI can load is the CJS bundle esbuild vendors into dist/lib/agent.js.
 * That is the property this whole ticket turns on, and it can regress
 * silently — a stray `external` entry, a dependency that stops bundling — so
 * it gets a test rather than a convention.
 *
 * Deliberately spawns a real `node -e`: importing through jest would prove
 * only that jest's module system can load it, which is not the claim.
 */
import { describe, expect, it, beforeAll } from '@jest/globals';
import { execFileSync } from 'child_process';
import * as path from 'path';
import { existsSync } from 'fs';

const BUNDLE = path.resolve(__dirname, '../../dist/lib/agent.js');

/** Run a snippet in a fresh plain-CJS node process; returns its stdout. */
function inPlainNode(script: string): string {
  return execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    cwd: path.resolve(__dirname, '../..'),
  }).trim();
}

describe('vendored @notefig/agent bundle', () => {
  beforeAll(() => {
    // The suite runs against build output by convention — the e2e specs
    // already exec dist/bin/notefig.js, and CI builds before testing. Say so
    // plainly rather than failing as "cannot find module".
    if (!existsSync(BUNDLE)) {
      throw new Error(`${BUNDLE} is missing — run \`npm run build\` first.`);
    }
  });

  it('is require-able from plain Node CJS', () => {
    const out = inPlainNode(
      `const a = require(${JSON.stringify(BUNDLE)});
       if (typeof a.NotefigAcpClient !== 'function') throw new Error('no client');
       process.stdout.write('ok');`,
    );
    expect(out).toBe('ok');
  });

  it('exports the surface a host needs to run a session', () => {
    const out = inPlainNode(
      `const a = require(${JSON.stringify(BUNDLE)});
       process.stdout.write(JSON.stringify(Object.keys(a).sort()));`,
    );
    const exported: string[] = JSON.parse(out);
    for (const name of [
      'NotefigAcpClient',
      'AgentTransportError',
      'createLoopbackPair',
      'subscribe',
      'transportToStreams',
      'sanitizeAcpFrame',
    ]) {
      expect(exported).toContain(name);
    }
  });

  it('inlines its ESM-only and version-sensitive dependencies', () => {
    // Two failure modes this guards, both reintroducible by one `external`
    // entry: requiring the ESM-only ACP package throws ERR_REQUIRE_ESM at
    // load, and requiring zod resolves the CLI's pinned 3.23.0, which has no
    // `zod/v3` subpath for zod-to-json-schema to import.
    const out = inPlainNode(
      `const src = require('fs').readFileSync(${JSON.stringify(BUNDLE)}, 'utf8');
       const externals = ['@zed-industries/agent-client-protocol', 'zod', 'zod/v3']
         .filter((name) => src.includes('require("' + name + '")'));
       process.stdout.write(JSON.stringify(externals));`,
    );
    expect(JSON.parse(out)).toEqual([]);
  });

  it('constructs a client and completes a scripted turn in plain Node', () => {
    // End to end, outside jest: the loopback pair plus a two-line scripted
    // agent is enough to prove the shipped artifact actually runs a session.
    const out = inPlainNode(`
      const { NotefigAcpClient, createLoopbackPair } = require(${JSON.stringify(BUNDLE)});
      const [clientSide, agentSide] = createLoopbackPair();
      agentSide.onLine((line) => {
        const m = JSON.parse(line);
        if (m.id === undefined) return;
        const result =
          m.method === 'initialize'
            ? { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }
            : m.method === 'session/new'
              ? { sessionId: 's1' }
              : { stopReason: 'end_turn' };
        agentSide.send(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      });
      const client = new NotefigAcpClient({
        taskId: 't',
        transport: clientSide,
        permissionBroker: { request: async () => ({ outcome: { outcome: 'cancelled' } }) },
        onSessionUpdate: () => {},
        fs: { readTextFile: async () => '', writeTextFile: async () => {} },
      });
      (async () => {
        await client.connect();
        const session = await client.newSession(process.cwd(), []);
        const response = await client.prompt(session.sessionId, [
          { type: 'text', text: 'hi' },
        ]);
        process.stdout.write(response.stopReason);
        process.exit(0);
      })().catch((error) => {
        process.stderr.write(String(error && error.stack || error));
        process.exit(1);
      });
    `);
    expect(out).toBe('end_turn');
  });
});
