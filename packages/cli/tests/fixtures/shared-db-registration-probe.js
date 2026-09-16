// Opens a fresh database through the shipped bundle, uses a collection the
// database has never seen, and prints every registry INSERT it executed.
/* eslint-disable */
const Database = require('better-sqlite3');
const { openSharedDb } = require('../../dist/lib/shared.js');

(async () => {
  const handle = new Database(process.argv[2], { timeout: 5000 });
  const executed = [];
  const prepare = handle.prepare.bind(handle);
  handle.prepare = (sql) => {
    executed.push(sql);
    return prepare(sql);
  };
  const db = openSharedDb(handle);
  await db.readKv('never-used-before', 'key');
  await db.close();
  const registrations = executed.filter(
    (sql) => /^\s*INSERT/.test(sql) && /collection_registry \(/.test(sql),
  );
  process.stdout.write(JSON.stringify(registrations) + '\n');
})().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
