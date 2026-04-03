import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, rmSync } from 'fs';

/**
 * Creates a unique temporary directory for tests that won't conflict with parallel test runs.
 * Uses process ID, test suite name, timestamp, and random string for uniqueness.
 */
export function createUniqueTempDir(testSuiteName: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  const pid = process.pid;
  
  // Use system temp dir with metrists prefix, including PID for parallel safety
  const tempDir = join(
    tmpdir(),
    'metrists-tests',
    `${testSuiteName}-pid${pid}-${timestamp}-${random}`
  );
  
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Get the absolute path to the CLI binary for testing.
 */
export function getCliPath(): string {
  // Resolve from the project root (packages/cli)
  return resolve(__dirname, '../../dist/bin/metrists.js');
}

/**
 * Safely removes a temp directory, handling race conditions and retries.
 */
export function cleanupTempDir(tempDir: string, maxRetries = 3): void {
  for (let i = 0; i < maxRetries; i++) {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      return; // Success
    } catch (err) {
      if (i === maxRetries - 1) {
        console.warn(`Failed to cleanup ${tempDir} after ${maxRetries} attempts:`, (err as Error).message);
      }
      // Small delay before retry
      const start = Date.now();
      while (Date.now() - start < 100) {
        // Busy wait
      }
    }
  }
}

/**
 * Generate a random directory name for tests that need multiple temp dirs
 */
export function generateRandomDirName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}
