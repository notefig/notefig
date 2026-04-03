import { join, dirname } from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { describe, expect, it, afterAll, beforeAll } from '@jest/globals';
import execa = require('execa');
import { hostHelpers } from '../../lib/utils/hosts.util';
import { createUniqueTempDir, cleanupTempDir, getCliPath } from './test-helpers';

describe('prune_command_deletes_the_right_files', () => {
  let tempDir: string;
  const timeout = 300000; // Increase timeout for init command

  beforeAll(async () => {
    tempDir = createUniqueTempDir('prune');

    const markdownFilePath = join(tempDir, 'test.md');
    writeFileSync(markdownFilePath, '# Test Markdown File', 'utf-8');

    await execa('node', [getCliPath(), 'init'], {
      cwd: tempDir,
    });
  }, timeout);

  afterAll(() => {
    cleanupTempDir(tempDir);
  }, timeout);

  it(
    'Should prune the .metrists directory and host config files',
    async () => {
      const directoryExistsBeforePrune = existsSync(join(tempDir, '.metrists'));
      expect(directoryExistsBeforePrune).toBe(true);

      // Collect all config file paths from all hosts
      const allConfigFilePaths: string[] = [];

      for (const [hostName, host] of Object.entries(hostHelpers)) {
        const configFilePaths = host.getConfigFilePaths();

        for (const configPath of configFilePaths) {
          allConfigFilePaths.push(configPath);

          // Create directory if needed (e.g., for .github/workflows/deploy.yml)
          const fullPath = join(tempDir, configPath);
          const dirPath = dirname(fullPath);

          if (!existsSync(dirPath)) {
            mkdirSync(dirPath, { recursive: true });
          }

          // Create the config file with test content
          writeFileSync(
            fullPath,
            `test content for ${hostName} config`,
            'utf-8',
          );
        }
      }

      // Verify all config files exist before pruning
      allConfigFilePaths.forEach((configPath) => {
        const fullPath = join(tempDir, configPath);
        expect(existsSync(fullPath)).toBe(true);
      });

      await execa('node', [getCliPath(), 'prune'], {
        cwd: tempDir,
      });

      const metristsDirPath = join(tempDir, '.metrists');
      const directoryExists = existsSync(metristsDirPath);

      expect(directoryExists).toBe(false);

      // Verify host config files are deleted appropriately
      allConfigFilePaths.forEach((configPath) => {
        const fullPath = join(tempDir, configPath);
        const exists = existsSync(fullPath);

        // S3 host files should only be deleted when .sst folder exists
        const isS3File =
          configPath === 'sst.config.ts' ||
          configPath.includes('.github/workflows/deploy.yml');
        const sstFolderExists = existsSync(join(tempDir, '.sst'));

        if (isS3File && !sstFolderExists) {
          // S3 files should be preserved when SST is not in use
          expect(exists).toBe(true);
        } else {
          // Other host files should be deleted
          expect(exists).toBe(false);
        }
      });
    },
    timeout,
  );
});
