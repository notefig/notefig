import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');

describe('init_command_creates_the_right_files', () => {
  const temp = join(__dirname, 'tmp-init');
  let tempDirName: string;
  let tempDir: string;
  const timeout = 100000;

  beforeAll(async () => {
    tempDirName = `test-init-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    tempDir = join(temp, tempDirName);
    mkdirSync(tempDir, { recursive: true });
    await execa('node', ['../../../../dist/bin/metrists.js', 'init'], {
      cwd: tempDir,
    });
  }, timeout);

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
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
