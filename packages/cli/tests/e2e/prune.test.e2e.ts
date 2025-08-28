import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');

describe('prune_command_deletes_the_right_files', () => {
  const temp = join(__dirname, 'tmp-prune');
  let tempDir: string;
  const timeout = 100000;

  beforeAll(async () => {
    tempDir = join(temp, `test-prune-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    mkdirSync(tempDir, { recursive: true });

    const markdownFilePath = join(tempDir, 'test.md');
    writeFileSync(markdownFilePath, '# Test Markdown File', 'utf-8');

    await execa('node', ['../../../../dist/bin/metrists.js', 'init'], {
      cwd: tempDir,
    });
  }, timeout);

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  }, timeout);

  it(
    'Should prune the .metrists directory',
    async () => {
      const directoryExistsBeforePrune = existsSync(join(tempDir, '.metrists'));
      expect(directoryExistsBeforePrune).toBe(true);

      await execa('node', ['../../../../dist/bin/metrists.js', 'prune'], {
        cwd: tempDir,
      });

      const metristsDirPath = join(tempDir, '.metrists');
      const directoryExists = existsSync(metristsDirPath);

      expect(directoryExists).toBe(false);
    },
    timeout,
  );
});
