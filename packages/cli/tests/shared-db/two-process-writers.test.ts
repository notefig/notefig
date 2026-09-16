/**
 * Several processes writing the app's database at once must neither lose a
 * write nor miss one another's.
 *
 * Without the shared coordinator this fails on both counts, silently: the
 * persistence library numbers writes from each process's own view and skips a
 * write whose number is already on disk, so two processes each writing 50
 * rows left 51 of 101 on disk, and neither could see the other's rows. Both
 * of the coordinator's ordering rules were found as races by this setup (1
 * row in 5 runs, and 9 runs in 20, went missing without them), so it runs
 * several rounds rather than one.
 *
 * Real processes, a real file, and the shipped vendored bundle: run
 * `npm run build` first, as the other packaging-level suites require.
 */
import { describe, expect, it } from '@jest/globals';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openSharedDb } from '../../lib/shared';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Database = require('better-sqlite3');

const WRITER = path.join(__dirname, '..', 'fixtures', 'shared-db-writer.js');
const LABELS = ['app', 'cli-a', 'cli-b'];
const ROWS_PER_PROCESS = 40;
const ROUNDS = 3;

function runWriter(
  dbPath: string,
  label: string,
): Promise<{ label: string; seen: number; warnings: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [WRITER, dbPath, label, String(ROWS_PER_PROCESS), LABELS.join(','), '15000'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${label} exited ${code}: ${stderr}`));
        return;
      }
      // Warnings (the library's recovery failures land on stderr) travel with
      // the result, so a wrong count arrives with its explanation.
      resolve({ ...JSON.parse(stdout.trim()), warnings: stderr.trim() });
    });
  });
}

/** Rows in the file, read by a fresh connection through TanStack. */
async function rowsOnDisk(dbPath: string): Promise<number> {
  const db = openSharedDb(new Database(dbPath, { timeout: 5000 }));
  try {
    return (await db.tasks.all()).length;
  } finally {
    await db.close();
  }
}

describe('processes sharing the app database', () => {
  it(
    'lose no writes and converge on every process\'s rows',
    async () => {
      const expectedTotal = LABELS.length * ROWS_PER_PROCESS;
      for (let round = 1; round <= ROUNDS; round++) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notefig-shared-db-'));
        const dbPath = path.join(dir, 'notefig.db');
        try {
          const writers = LABELS.map((label) => runWriter(dbPath, label));
          // Every process opens the database before any of them writes.
          await new Promise((resolve) => setTimeout(resolve, 400));
          fs.writeFileSync(`${dbPath}.go`, '');
          const results = await Promise.all(writers);

          expect({ round, onDisk: await rowsOnDisk(dbPath) }).toEqual({
            round,
            onDisk: expectedTotal,
          });
          for (const result of results) {
            const { warnings, ...seen } = result;
            expect({ round, ...seen, warnings: seen.seen === expectedTotal ? '' : warnings }).toEqual({
              round,
              label: result.label,
              seen: expectedTotal,
              warnings: '',
            });
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    120_000,
  );

  it('registers a new collection with the race-safe statement', () => {
    // Guards raceSafeRegistrationSql: if the library stops issuing the exact
    // registration INSERT it rewrites, the rewrite silently stops applying and
    // concurrent first use breaks again. This fails first instead. A child
    // process, like the writers: the bundle's TanStack dependencies load as
    // CommonJS under plain Node, not under Jest's module loader.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notefig-registration-'));
    try {
      const probe = path.join(__dirname, '..', 'fixtures', 'shared-db-registration-probe.js');
      const output = execFileSync(process.execPath, [probe, path.join(dir, 'notefig.db')], {
        encoding: 'utf8',
      });
      const registrations: string[] = JSON.parse(output.trim());
      expect(registrations.length).toBeGreaterThan(0);
      for (const sql of registrations) {
        expect(sql).toMatch(/^\s*INSERT OR IGNORE INTO collection_registry \(/);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
