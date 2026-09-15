/**
 * A scripted ACP agent for the headless-host tests: sits on the agent side
 * of a LoopbackTransport pair and answers the real NotefigAcpClient, so a
 * full session runs in CI with no harness installed.
 *
 * FINDING (MET-182, for MET-183): this duplicates `FakeAgent` in
 * packages/desktop/src/agent/mock-harness.ts, which the ticket hoped to
 * reuse. It cannot be imported from a Node CJS host today, for two reasons
 * that are both squarely the core extraction's job:
 *
 *   1. mock-harness.ts:414 reads `import.meta.env.VITE_AGENT_MOCK` at module
 *      scope — a Vite-only global with no CJS equivalent.
 *   2. mock-harness.ts:610 does `await import("./agent-collections")`,
 *      pulling the desktop TanStack DB collections layer into the graph.
 *      That module doesn't even parse under the CLI's TypeScript 4.8
 *      (`satisfies`, agent-collections.ts:51).
 *
 * The scripted agent's own logic is host-neutral; only its wiring is stuck
 * to the app. When MET-183 splits the collections out and moves the mock
 * behind the host contract, this file should be deleted in favour of the
 * shared one.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export type ScriptedTurn = {
  /** Text chunks streamed as agent_message_chunk before the turn ends. */
  chunks?: string[];
  /** Defaults to "end_turn". */
  stopReason?: string;
  /** Called with the prompt request params, for assertions. */
  onPrompt?: (params: Json) => void;
};

export type ScriptedAgentOptions = {
  /** Answer `initialize` with these auth methods (default: none). */
  authMethods?: Json[];
  /**
   * What each successive prompt does; the last entry repeats. An EMPTY array
   * means the agent completes the handshake and then never answers a prompt
   * — the "wedged adapter" case, used to test timeouts and forced teardown.
   */
  turns: ScriptedTurn[];
};

/** The slice of a transport the scripted agent drives. */
export type LineChannel = {
  send(line: string): void;
  onLine(callback: (line: string) => void): () => void;
};

/** The protocol writes a handler is allowed to make. */
type Responder = {
  reply(id: Json, result: Json): void;
  notify(method: string, params: Json): void;
  error(id: Json, code: number, message: string): void;
};

function makeResponder(channel: LineChannel): Responder {
  const send = (payload: Json) => channel.send(JSON.stringify(payload));
  return {
    reply: (id, result) => send({ jsonrpc: '2.0', id, result }),
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    error: (id, code, message) =>
      send({ jsonrpc: '2.0', id, error: { code, message } }),
  };
}

/**
 * Drive the agent side of a loopback pair. Implements just enough ACP for a
 * single-turn session: initialize, session/new, session/prompt.
 *
 * Methods live in a table so each stays small and adding one doesn't grow a
 * single branching function.
 */
export function attachScriptedAgent(
  channel: LineChannel,
  options: ScriptedAgentOptions,
): { promptCount: () => number } {
  const respond = makeResponder(channel);
  let promptIndex = 0;

  const answerPrompt = (message: Json) => {
    promptIndex += 1;
    // No script: stay silent, leaving the turn outstanding on purpose.
    if (options.turns.length === 0) return;
    const turn = options.turns[Math.min(promptIndex - 1, options.turns.length - 1)];
    turn?.onPrompt?.(message.params);
    const sessionId = message.params?.sessionId;
    for (const text of turn?.chunks ?? []) {
      respond.notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
    }
    respond.reply(message.id, { stopReason: turn?.stopReason ?? 'end_turn' });
  };

  const methods: Record<string, (message: Json) => void> = {
    initialize: (message) =>
      respond.reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: options.authMethods ?? [],
      }),
    'session/new': (message) =>
      respond.reply(message.id, { sessionId: 'scripted-session-1' }),
    'session/prompt': answerPrompt,
  };

  channel.onLine((line) => {
    let message: Json;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return; // a notification; nothing to answer
    const handler = methods[message.method as string];
    // Method not found — the same answer a real adapter gives.
    if (handler) handler(message);
    else respond.error(message.id, -32601, `unknown method ${message.method}`);
  });

  return { promptCount: () => promptIndex };
}

/**
 * A scripted agent that honours `session/cancel`: it parks the prompt and
 * only answers once cancelled, which is the graceful-cancellation path.
 * Returns a flag reporting whether the cancel actually arrived.
 */
export function attachCancellableAgent(channel: LineChannel): {
  sawCancel: () => boolean;
} {
  const respond = makeResponder(channel);
  let promptId: Json = null;
  let sawCancel = false;

  const methods: Record<string, (message: Json) => void> = {
    initialize: (message) =>
      respond.reply(message.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        authMethods: [],
      }),
    'session/new': (message) => respond.reply(message.id, { sessionId: 's1' }),
    'session/prompt': (message) => {
      promptId = message.id; // deliberately unanswered until cancelled
    },
    'session/cancel': () => {
      sawCancel = true;
      respond.reply(promptId, { stopReason: 'cancelled' });
    },
  };

  channel.onLine((line) => {
    const message = JSON.parse(line);
    methods[message.method as string]?.(message);
  });

  return { sawCancel: () => sawCancel };
}
