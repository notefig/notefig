/**
 * Scripted stdio process for supervisor tests — a stand-in for an ACP
 * adapter (the desktop FakeAgent is bound to in-memory transports, so this
 * tiny stdio port exists instead). Behavior per stdin line:
 *   "exit:<code>"  → exit with that code
 *   "stderr:<msg>" → write <msg> to stderr
 *   anything else  → write "echo:<line>" to stdout
 * On start it writes "ready" to stdout.
 */
process.stdout.write('ready\n');

let tail = '';
process.stdin.on('data', (chunk) => {
  const pieces = (tail + chunk.toString()).split('\n');
  tail = pieces.pop() ?? '';
  for (const line of pieces) {
    if (!line) continue;
    if (line.startsWith('exit:')) {
      process.exit(Number(line.slice(5)));
    } else if (line.startsWith('stderr:')) {
      process.stderr.write(`${line.slice(7)}\n`);
    } else if (line.startsWith('env:')) {
      process.stdout.write(`env:${process.env[line.slice(4)] ?? ''}\n`);
    } else if (line === 'cwd') {
      process.stdout.write(`cwd:${process.cwd()}\n`);
    } else {
      process.stdout.write(`echo:${line}\n`);
    }
  }
});

// SIGTERM-able but never exits on its own.
setInterval(() => undefined, 60_000);
