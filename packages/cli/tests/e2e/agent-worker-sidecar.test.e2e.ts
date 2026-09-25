import { describe, expect, it } from '@jest/globals';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { resolveSidecarProgram } from '../../lib/agent-worker';
import { BUILT_IN_HARNESSES, parseSidecarCommand } from '@notefig/shared';

/**
 * MET-210: the worker runs a `sidecar:` harness from the adapter bundle
 * vendored into the CLI, on its own node — never npx.
 */
describe('agent worker sidecar resolution', () => {
  it('claude-code names a sidecar the CLI must carry', () => {
    const claude = BUILT_IN_HARNESSES.find((h) => h.id === 'claude-code')!;
    expect(parseSidecarCommand(claude.command)).toBe('claude-agent-acp');
  });

  it('spawns the vendored bundle with the running node', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notefig-sidecars-'));
    const bundle = path.join(dir, 'claude-agent-acp.cjs');
    await fs.writeFile(bundle, '// stub');
    expect(resolveSidecarProgram('claude-agent-acp', dir)).toEqual({
      command: process.execPath,
      args: [bundle],
    });
  });

  it('refuses to run the adapter on a Node older than it supports', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notefig-sidecars-'));
    await fs.writeFile(path.join(dir, 'claude-agent-acp.cjs'), '// stub');
    expect(() => resolveSidecarProgram('claude-agent-acp', dir, '20.19.0')).toThrow(
      /needs Node 22\+ .*running on Node 20\.19\.0/,
    );
    expect(resolveSidecarProgram('claude-agent-acp', dir, '22.0.0').command).toBe(
      process.execPath,
    );
  });

  it('reports an unbuilt CLI as such, not as a spawn failure', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notefig-sidecars-'));
    expect(() => resolveSidecarProgram('claude-agent-acp', dir)).toThrow(
      /bundled adapter `claude-agent-acp` missing.*npm run build/,
    );
  });
});
