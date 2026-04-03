import { join } from 'path';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');
import { createUniqueTempDir, cleanupTempDir, getCliPath } from './test-helpers';

describe('init_command_creates_the_right_files', () => {
  let tempDirName: string;
  let tempDir: string;
  const timeout = 300000; // Increase timeout for npm install

  beforeAll(async () => {
    tempDir = createUniqueTempDir('init');
    // Extract just the directory name for the test assertions
    tempDirName = tempDir.split('/').pop() || tempDir.split('\\').pop() || 'test';
    await execa('node', [getCliPath(), 'init'], {
      cwd: tempDir,
    });
  }, timeout);

  afterAll(() => {
    cleanupTempDir(tempDir);
  }, timeout);

  it(
    'Should create a .metrists',
    async () => {
      const markdownFilePath = join(tempDir, 'test.md');
      writeFileSync(markdownFilePath, '# Test Markdown File', 'utf-8');

      const metristsDirPath = join(tempDir, '.metrists');
      const directoryExists = existsSync(metristsDirPath);

      expect(directoryExists).toBe(true);
    },
    timeout,
  );

  it(
    '.gitignore should exist and contain .metrists',
    async () => {
      const gitignorePath = join(tempDir, '.gitignore');
      const gitignoreExists = existsSync(gitignorePath);

      expect(gitignoreExists).toBe(true);

      const fileContent = readFileSync(gitignorePath, 'utf-8');
      expect(fileContent).toContain('.metrists');
    },
    timeout,
  );

  it(
    'meta file should exists and contain the right content',
    async () => {
      const metaPath = join(tempDir, 'meta.md');
      const metaExists = existsSync(metaPath);

      expect(metaExists).toBe(true);

      const fileContent = readFileSync(metaPath, 'utf-8');
      expect(fileContent).toContain(`title: ${tempDirName.replace(new RegExp(
        '-', 'g'
      ), ' ')}`);
    },
    timeout,
  );
});
