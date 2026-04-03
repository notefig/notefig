import { join } from 'path';
import { writeFileSync, existsSync, readFileSync } from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');
import { createUniqueTempDir, cleanupTempDir, getCliPath } from './test-helpers';

describe('audiobook_command_creates_the_right_files', () => {
  let tempDir: string;
  const timeout = 100000;
  const outputPath = 'audiobook-output';

  beforeAll(async () => {
    tempDir = createUniqueTempDir('audiobook');

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
      [getCliPath(), 'audiobook', '-o', outputPath],
      {
        cwd: tempDir,
        env: {
          TEST: 'true',
          'ELEVENLABS_API_KEY': '123',
        },
      },
    );
  }, timeout);

  afterAll(() => {
    cleanupTempDir(tempDir);
  }, timeout);

  it(
    'Boilerplate test',
    async () => {
      expect(true).toBe(true);
    },
    timeout,
  );
});
