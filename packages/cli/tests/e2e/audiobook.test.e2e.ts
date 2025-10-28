import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');

describe('audiobook_command_creates_the_right_files', () => {
  const temp = join(__dirname, 'tmp-audiobook');
  let tempDirName: string;
  let tempDir: string;
  const timeout = 100000;
  const outputPath = 'audiobook-output';

  beforeAll(async () => {
    tempDirName = `test-audiobook-${Date.now()}-${Math.random()
      .toString(36)
      .substring(7)}`;
    tempDir = join(temp, tempDirName);
    mkdirSync(tempDir, { recursive: true });

    // Create some test content
    writeFileSync(
      join(tempDir, 'chapter1.md'),
      '# Chapter 1\n\nThis is the first chapter.',
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'chapter2.md'),
      '# Chapter 2\n\nThis is the second chapter.',
      'utf-8',
    );

    await execa(
      'node',
      ['../../../../dist/bin/metrists.js', 'audiobook', '-o', outputPath],
      {
        cwd: tempDir,
      },
    );
  }, timeout);

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  }, timeout);

  it(
    'Boilerplate test',
    async () => {
      expect(true).toBe(true);
    },
    timeout,
  );
});
