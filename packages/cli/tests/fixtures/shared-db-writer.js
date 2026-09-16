// One process sharing the app's database, as a CLI run would: opens the file
// through the shipped vendored bundle, waits for the go signal so every
// process writes at once, inserts its rows, then waits until it can see every
// process's rows. Prints what it saw as one JSON line.
/* eslint-disable */
const runMain = require('./run-main');
const fs = require('fs');
const Database = require('better-sqlite3');
const { openSharedDb } = require('../../dist/lib/shared.js');

const [dbPath, label, countArg, labelsCsv, deadlineArg] = process.argv.slice(2);
const count = Number(countArg);
const labels = labelsCsv.split(',');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

runMain(async () => {
  const handle = new Database(dbPath, { timeout: 5000 });
  const db = openSharedDb(handle, { pollIntervalMs: 50 });

  while (!fs.existsSync(`${dbPath}.go`)) await sleep(5);

  const now = Date.now();
  for (let i = 0; i < count; i++) {
    await db.tasks.insert({
      taskId: `${label}-${i}`,
      workspacePath: '/ws',
      title: `${label} ${i}`,
      status: 'idle',
      harnessId: 'claude-code',
      createdAt: now,
      updatedAt: now,
    });
  }

  const expected = labels.flatMap((l) =>
    Array.from({ length: count }, (_, i) => `${l}-${i}`),
  );
  const deadline = Date.now() + Number(deadlineArg);
  while (Date.now() < deadline && !expected.every((id) => db.tasks.get(id))) {
    await sleep(25);
  }
  const seen = expected.filter((id) => db.tasks.get(id)).length;
  process.stdout.write(JSON.stringify({ label, seen }) + '\n');
  await db.close();
});
