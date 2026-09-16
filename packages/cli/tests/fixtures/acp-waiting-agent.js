// A stdio ACP agent for signal tests: accepts a session, then leaves the
// prompt unanswered until session/cancel arrives, like a real harness mid-turn.
// Writes "prompted" to the file named by ACP_WAITING_AGENT_MARKER once the
// prompt is outstanding, so a test knows when to send its signal.
/* eslint-disable */
const fs = require('fs');

const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
let pendingPrompt = null;

// One handler per method, as in tests/agent-host/scripted-agent.ts.
const methods = {
  initialize: (message) =>
    reply(message.id, { protocolVersion: 1, agentCapabilities: {}, authMethods: [] }),
  'session/new': (message) => reply(message.id, { sessionId: 'waiting-session-1' }),
  'session/prompt': (message) => {
    pendingPrompt = message.id;
    if (process.env.ACP_WAITING_AGENT_MARKER) {
      fs.writeFileSync(process.env.ACP_WAITING_AGENT_MARKER, 'prompted');
    }
  },
  'session/cancel': () => {
    if (pendingPrompt === null) return;
    reply(pendingPrompt, { stopReason: 'cancelled' });
    pendingPrompt = null;
  },
};

function handle(line) {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const handler = methods[message.method];
  if (handler) return handler(message);
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split('\n');
  buffer = lines.pop();
  lines.forEach(handle);
});
