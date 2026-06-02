import { join } from 'path';
import { writeFileSync } from 'fs';
import { describe, expect, it, afterEach, beforeAll } from '@jest/globals';
import execa = require('execa');
import {
  createUniqueTempDir,
  cleanupTempDir,
  getCliPath,
} from './test-helpers';

describe('config_validation_errors', () => {
  const createdTempDirs: string[] = [];
  const timeout = 180000;

  beforeAll(async () => {
    await execa('npm', ['run', 'build'], {
      cwd: join(__dirname, '..', '..'),
    });
  }, timeout);

  afterEach(() => {
    while (createdTempDirs.length > 0) {
      const dir = createdTempDirs.pop();
      if (dir) {
        cleanupTempDir(dir);
      }
    }
  });

  function createTempProject(metristsrcContent?: string): string {
    const tempDir = createUniqueTempDir('config-validation');
    createdTempDirs.push(tempDir);

    writeFileSync(join(tempDir, 'test.md'), '# Hello', 'utf-8');
    if (metristsrcContent !== undefined) {
      writeFileSync(
        join(tempDir, '.metristsrc'),
        metristsrcContent,
        'utf-8',
      );
    }

    return tempDir;
  }

  async function runInitAndExpectConfigError(
    tempDir: string,
    expectedMessage: string,
  ): Promise<string> {
    const result = await execa('node', [getCliPath(), 'init'], {
      cwd: tempDir,
      reject: false,
    });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain('Project config error');
    expect(output).toContain(expectedMessage);

    return output;
  }

  it(
    'fails on malformed json',
    async () => {
      const tempDir = createTempProject(
        '{"$schema": "https://raw.githubusercontent.com/metrists/metrists/main/schemas/project-config/v1.schema.json",',
      );

      await runInitAndExpectConfigError(tempDir, 'not valid JSON');
    },
    timeout,
  );

  it(
    'fails on unsupported $schema url',
    async () => {
      const tempDir = createTempProject(
        JSON.stringify(
          {
            $schema:
              'https://raw.githubusercontent.com/metrists/metrists/main/schemas/project-config/v2.schema.json',
            outputs: {
              web: {
                enabled: true,
                outDir: '.metrists',
                theme: 'metrists-theme-next',
                deploy: { provider: null, options: {} },
              },
              epub: { enabled: false, coverImagePath: 'cover.jpg' },
              pdf: { enabled: false },
              audiobook: {
                enabled: false,
                provider: 'elevenlabs',
                apiKey: '$ELEVENLABS_API_KEY',
                voiceId: '$ELEVENLABS_VOICE_ID',
                modelId: 'eleven_multilingual_v2',
                format: 'mp3_44100_128',
              },
            },
          },
          null,
          2,
        ),
      );

      await runInitAndExpectConfigError(
        tempDir,
        'Unsupported .metristsrc schema version',
      );
    },
    timeout,
  );
});
