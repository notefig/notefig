// Registers acp-waiting-agent.js as a custom harness in a database, the way the
// app's settings screen does, through the shipped bundle.
/* eslint-disable */
const runMain = require('./run-main');
const path = require('path');
const Database = require('better-sqlite3');
const { openSharedDb } = require('../../dist/lib/shared.js');

runMain(async () => {
  const db = openSharedDb(new Database(process.argv[2], { timeout: 5000 }));
  await db.writeKv('harness-settings', 'custom', [
    {
      id: 'waiting',
      label: 'Waiting test agent',
      command: process.execPath,
      args: [path.join(__dirname, 'acp-waiting-agent.js')],
      env: {},
      mcpRegistrationOverride: 'none',
      enabled: true,
    },
  ]);
  await db.close();
});
