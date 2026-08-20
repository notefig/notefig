/**
 * The mock agent, whole: a scripted ACP agent, the scenarios it plays, and
 * the env-gated harness (VITE_AGENT_MOCK=1) that serves it through the
 * agent-transport seam in place of a spawned adapter process. The app runs
 * its REAL ACP client, agent service, collections and chat UI — only the
 * process on the far side of the transport is fake, which is exactly the
 * seam the AgentTransport interface promises (loopback is named there as
 * the test primitive). One file on purpose: agent + scenarios + wiring are
 * one protocol.
 *
 * Two consumers:
 *  - unit tests script `FakeAgent` directly per-assertion;
 *  - mock-mode app runs (and the tests/agent e2e specs) drive it with
 *    scenarios — `window.__mockAgent.configure({ scenario, options })`, or
 *    a prompt starting with `@@mock:{...json...}` typed straight into the
 *    composer (a one-turn override, handy for manual repros).
 *
 * PRODUCTION SAFETY: every harness entry point checks `MOCK_AGENT_MODE`,
 * which Vite statically evaluates to false in normal builds (same pattern
 * as testing/shim-transport.ts), so this dead-code-eliminates away.
 */
import { createLoopbackPair } from "@notefig/agent";
import type { LoopbackTransport } from "@notefig/agent";
import type { AgentTransport, McpEndpoint } from "@notefig/agent";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

// ─── The scripted agent ─────────────────────────────────────────────────────

/** The slice of a transport the scripted agent drives (the agent side of a
 *  LoopbackTransport pair — or anything line-shaped). */
export type ScriptedAgentLineChannel = {
  send(line: string): void;
  onLine(callback: (line: string) => void): () => void;
};

/**
 * A scripted ACP agent: sits on the agent side of a LoopbackTransport pair
 * and answers the real client (ClientSideConnection driven by AgentTask).
 * Replaces a fake adapter process.
 */
export class FakeAgent {
  private nextId = 1;
  private pendingClientRequests = new Map<number, (result: Json) => void>();

  initializeResult: Json = {
    protocolVersion: 1,
    agentCapabilities: {},
    authMethods: [],
  };
  newSessionResult: Json = { sessionId: "sess_test" };
  /** Captured `session/new` params (mcpServers pass-through assertions). */
  newSessionParams: Json | null = null;
  /** Scripted `session/new`: defaults to returning {@link newSessionResult};
   *  throwing rejects the call, and a never-resolving promise hangs it (for
   *  startup-timeout tests). */
  onNewSession: (params: Json, agent: FakeAgent) => Promise<Json> = async () =>
    this.newSessionResult;
  /** Scripted turn behavior; may emit updates / request permission via `this`. */
  onPrompt: (
    params: Json,
    agent: FakeAgent,
  ) => Promise<{ stopReason: string }> = async () => ({
    stopReason: "end_turn",
  });
  /** Scripted `authenticate` behavior; throwing rejects the call. */
  onAuthenticate: (params: Json, agent: FakeAgent) => Promise<Json> =
    async () => ({});
  /** Captured `session/load` params (revival assertions). */
  loadSessionParams: Json | null = null;
  /** Scripted `session/load`: emit replay updates via `this` before
   *  returning; throwing rejects the call (evicted session). */
  onLoadSession: (params: Json, agent: FakeAgent) => Promise<Json> =
    async () => ({});
  /** Captured `session/close` params (refresh re-sync assertions). */
  closeSessionParams: Json | null = null;
  /** Scripted `session/close` (the app sends it as a raw request — the
   *  pinned client library predates the method); throwing rejects it,
   *  which callers treat as "close unsupported". */
  onCloseSession: (params: Json, agent: FakeAgent) => Promise<Json> =
    async () => ({});
  /** `session/cancel` notification hook (the harness aborts its scenario). */
  onCancel: (params: Json, agent: FakeAgent) => void = () => {};

  constructor(private readonly transport: ScriptedAgentLineChannel) {
    transport.onLine((line) => void this.handle(JSON.parse(line)));
  }

  private sendRaw(obj: Json): void {
    this.transport.send(JSON.stringify(obj));
  }

  respond(id: number, result: Json): void {
    this.sendRaw({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number, code: number, message: string): void {
    this.sendRaw({ jsonrpc: "2.0", id, error: { code, message } });
  }

  notify(method: string, params: Json): void {
    this.sendRaw({ jsonrpc: "2.0", method, params });
  }

  /** Emit a session/update notification to the client. */
  update(sessionId: string, update: Json): void {
    this.notify("session/update", { sessionId, update });
  }

  /** Send a request to the client (fs/*, request_permission) and await its reply. */
  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pendingClientRequests.set(id, resolve);
      this.sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Run a scripted handler and respond with its result, or map a throw to
   *  a JSON-RPC error under the given code (a hung promise hangs the call —
   *  that's how startup-timeout tests script a silent adapter). */
  private async answer(
    id: number,
    errorCode: number,
    run: () => Promise<Json>,
  ): Promise<void> {
    try {
      this.respond(id, await run());
    } catch (error) {
      this.respondError(
        id,
        errorCode,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handle(msg: Json): Promise<void> {
    // A response to one of our client-directed requests (no method field).
    if (msg.method === undefined && msg.id !== undefined) {
      const cb = this.pendingClientRequests.get(msg.id);
      if (cb) {
        this.pendingClientRequests.delete(msg.id);
        cb(msg.result);
      }
      return;
    }

    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        return this.respond(id, this.initializeResult);
      case "session/new":
        this.newSessionParams = params;
        return this.answer(id, -32603, () => this.onNewSession(params, this));
      case "session/load":
        this.loadSessionParams = params;
        return this.answer(id, -32603, () => this.onLoadSession(params, this));
      case "session/close":
        this.closeSessionParams = params;
        return this.answer(id, -32601, () => this.onCloseSession(params, this));
      case "authenticate":
        return this.answer(id, -32000, () => this.onAuthenticate(params, this));
      case "session/prompt":
        return this.answer(id, -32000, () => this.onPrompt(params, this));
      case "session/cancel":
        this.onCancel(params, this);
        return; // notification, no response
      default:
        if (id !== undefined) this.respondError(id, -32601, "not implemented");
    }
  }
}

// ─── Scenarios ──────────────────────────────────────────────────────────────

/** What a scenario gets to work with for one `session/prompt` turn. */
export type MockTurnContext = {
  sessionId: string;
  /** Concatenated text blocks of the prompt that started this turn. */
  promptText: string;
  /** Emit one `session/update` notification to the client. */
  emit: (update: Json) => void;
  /** Abort-aware delay; 0 still yields a macrotask so the UI breathes. */
  sleep: (ms: number) => Promise<void>;
  /** Fires on `session/cancel`; scenarios should return promptly after. */
  signal: AbortSignal;
};

/** A scenario plays one turn; the resolved stopReason answers the prompt. */
export type MockScenario = (
  ctx: MockTurnContext,
) => Promise<{ stopReason: string } | void>;

export type MockScenarioFactory = (options: Json) => MockScenario;

export type LongTranscriptOptions = {
  /** Sections to stream; each is ~a thought + tool call + markdown message. */
  sections?: number;
  /** Characters per agent_message_chunk. */
  chunkSize?: number;
  /** Delay between chunks (0 = macrotask yield only — as fast as possible). */
  delayMs?: number;
  /** Every n-th section opens with a streamed thought run. */
  thoughtEvery?: number;
  /** Every n-th section emits a plan update. */
  planEvery?: number;
  /** Every n-th tool call carries a file diff instead of text output. */
  diffEvery?: number;
  /** Markdown blocks per assistant message. */
  blocksPerMessage?: number;
  /**
   * Uniquifies every generated string. Distinct labels defeat the rendered-
   * HTML cache in ui/markdown.tsx, so repeat runs measure real worker
   * renders, not cache hits.
   */
  seedLabel?: string;
};

/** Markdown block templates covering the elements the chat renders (n is a
 *  unique counter, s the seed label — every instantiation is distinct text). */
const MARKDOWN_BLOCKS: Array<(n: number, s: string) => string> = [
  (n, s) => `## Findings for pass ${n} (${s})\n`,
  (n) =>
    `The refactor in step ${n} touches **three modules** and keeps the ` +
    `public API stable. The \`resolveWorkspacePath\` helper now returns a ` +
    `*discriminated union*, which callers narrow before use — see the ` +
    `[design notes](https://example.com/notes/${n}) for the full rationale.\n`,
  (n) =>
    `\`\`\`ts\nexport function migrate${n}(rows: Row[]): Row[] {\n` +
    `  return rows\n    .filter((row) => row.status !== "deleted")\n` +
    `    .map((row) => ({ ...row, version: ${n}, checkedAt: Date.now() }));\n}\n\`\`\`\n`,
  (n) =>
    `| File | Status | Lines |\n| --- | --- | --- |\n` +
    `| src/module-${n}.ts | changed | +${(n * 7) % 90} |\n` +
    `| src/module-${n}.test.ts | added | +${(n * 13) % 120} |\n` +
    `| docs/notes-${n}.md | removed | -${(n * 3) % 40} |\n`,
  (n) =>
    `1. Load the fixture set ${n}\n2. Run the migration\n` +
    `   - verify the checksum\n   - verify row counts\n3. Diff the output\n`,
  (n) =>
    `> Note ${n}: the watcher coalesces events per path, so a rename can ` +
    `arrive as delete+create — handle both orders.\n`,
  (n) =>
    `- [x] parse the manifest ${n}\n- [x] resolve dependencies\n` +
    `- [ ] emit the lockfile\n`,
  (n) =>
    `Long identifier stress: \`averyLongUnbrokenIdentifierName${n}ThatMustWrapInsideTheBubbleWithoutPushingThePageWide\` ` +
    `and a bare URL https://example.com/deep/path/segment-${n}/with-quite-a-few/segments?query=${n}\n`,
  (n) =>
    `\`\`\`python\ndef check_${n}(items):\n    seen = set()\n` +
    `    for item in items:\n        if item.key in seen:\n` +
    `            raise ValueError(f"dup {item.key}")\n        seen.add(item.key)\n\`\`\`\n`,
  () => `---\n`,
];

function markdownMessage(
  section: number,
  blocks: number,
  seed: string,
): string {
  const parts: string[] = [];
  for (let b = 0; b < blocks; b++) {
    const template =
      MARKDOWN_BLOCKS[(section * 3 + b) % MARKDOWN_BLOCKS.length];
    parts.push(template(section * 100 + b, seed));
  }
  return parts.join("\n");
}

const THOUGHT_TEXT = (n: number, s: string) =>
  `Considering approach ${n} (${s}): the transcript grows monotonically, so ` +
  `the collection index stays warm; the interesting cost is the re-render ` +
  `path per streamed chunk. Weighing windowing against virtualization before ` +
  `touching the scroller primitive.`;

/**
 * The long-history workload: streams `sections` rounds of thought → tool
 * call (pending → in_progress → completed) → markdown message, with
 * periodic plans and diff-bearing tools — the element mix a real long
 * session accumulates, at a configurable pace.
 */
export function longTranscript(
  options: LongTranscriptOptions = {},
): MockScenario {
  const {
    sections = 40,
    chunkSize = 120,
    delayMs = 0,
    thoughtEvery = 2,
    planEvery = 8,
    diffEvery = 5,
    blocksPerMessage = 4,
    seedLabel = "seed",
  } = options;

  return async ({ sessionId, emit, sleep, signal }) => {
    const streamText = async (
      kind: "agent_message_chunk" | "agent_thought_chunk",
      text: string,
    ) => {
      for (let at = 0; at < text.length; at += chunkSize) {
        if (signal.aborted) return;
        emit({
          sessionUpdate: kind,
          content: { type: "text", text: text.slice(at, at + chunkSize) },
        });
        await sleep(delayMs);
      }
    };

    for (let section = 0; section < sections; section++) {
      if (signal.aborted) return { stopReason: "cancelled" };

      if (section % thoughtEvery === 0) {
        await streamText(
          "agent_thought_chunk",
          THOUGHT_TEXT(section, seedLabel),
        );
      }

      const toolCallId = `mock_tool_${seedLabel}_${section}`;
      const withDiff = section % diffEvery === 0;
      const path = `src/generated/file-${section}.ts`;
      emit({
        sessionUpdate: "tool_call",
        toolCallId,
        title: withDiff ? "edit_file" : "run_command",
        kind: withDiff ? "edit" : "execute",
        status: "pending",
        rawInput: withDiff
          ? { path }
          : { command: `rg --stats "pattern-${section}" src/ --glob '*.ts'` },
      });
      await sleep(delayMs);
      emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "in_progress",
      });
      await sleep(delayMs);
      emit({
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: withDiff
          ? [
              {
                type: "diff",
                path,
                oldText: `export const value = ${section};\n`,
                newText:
                  `export const value = ${section + 1};\n` +
                  `export const label = "${seedLabel}-${section}";\n` +
                  `export const checked = true;\n`,
              },
            ]
          : [
              {
                type: "content",
                content: {
                  type: "text",
                  text:
                    `${(section * 17) % 300} matches\n` +
                    `${(section * 5) % 40} files contained matches\n` +
                    `elapsed: 0.0${section % 9}s`,
                },
              },
            ],
      });

      if (section % planEvery === 0) {
        emit({
          sessionUpdate: "plan",
          entries: Array.from({ length: 4 }, (_, i) => ({
            content: `Step ${i + 1} of pass ${section} (${seedLabel})`,
            priority: "medium",
            status: i < 2 ? "completed" : i === 2 ? "in_progress" : "pending",
          })),
        });
      }

      await streamText(
        "agent_message_chunk",
        markdownMessage(section, blocksPerMessage, seedLabel),
      );
    }
    return { stopReason: "end_turn" };
  };
}

/** Default scenario: a short streamed echo — enough to see the loop work. */
export function echo(): MockScenario {
  return async ({ promptText, emit, sleep, signal }) => {
    const reply = `You said:\n\n> ${promptText || "(nothing)"}\n\nMock harness reporting in.`;
    for (let at = 0; at < reply.length && !signal.aborted; at += 24) {
      emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: reply.slice(at, at + 24) },
      });
      await sleep(10);
    }
    return { stopReason: "end_turn" };
  };
}

// ─── The env-gated harness ──────────────────────────────────────────────────

export const MOCK_AGENT_MODE = import.meta.env.VITE_AGENT_MOCK === "1";

export type MockAgentConfig = {
  scenario: string;
  options?: Json;
};

const scenarioRegistry = new Map<string, MockScenarioFactory>([
  ["echo", () => echo()],
  ["longTranscript", (options) => longTranscript(options ?? {})],
]);

let activeConfig: MockAgentConfig = { scenario: "echo" };

/** Set the scenario future `session/prompt` turns play (all mock tasks). */
export function configureMockAgent(config: MockAgentConfig): void {
  if (!scenarioRegistry.has(config.scenario)) {
    throw new Error(
      `unknown mock scenario "${config.scenario}" (have: ${[...scenarioRegistry.keys()].join(", ")})`,
    );
  }
  activeConfig = config;
}

/** Extension point kept deliberately open — future agent-workflow tests
 *  register their own exchanges without touching this file. */
export function registerMockScenario(
  name: string,
  factory: MockScenarioFactory,
): void {
  scenarioRegistry.set(name, factory);
}

/** `@@mock:{"scenario":"longTranscript","options":{...}}` prompt directive —
 *  a one-turn config override, usable from the real composer. */
function configFromPrompt(promptText: string): MockAgentConfig | null {
  if (!promptText.startsWith("@@mock:")) return null;
  try {
    const parsed = JSON.parse(promptText.slice("@@mock:".length));
    if (
      typeof parsed?.scenario === "string" &&
      scenarioRegistry.has(parsed.scenario)
    ) {
      return parsed as MockAgentConfig;
    }
  } catch {
    // fall through — treat as a normal prompt
  }
  return null;
}

function promptText(params: Json): string {
  const blocks: Json[] = params?.prompt ?? [];
  return blocks
    .filter((block: Json) => block?.type === "text")
    .map((block: Json) => block.text)
    .join("\n");
}

let mockSessionCounter = 0;

/**
 * Per-session update history for the scenario agent, keyed by sessionId and
 * module-level so it survives the transport (mock revival spawns a fresh
 * FakeAgent, exactly like respawning a real adapter). `session/load` replays
 * it the way real adapters replay their persisted store: each historical
 * user prompt as a single user_message_chunk, then the turn's updates —
 * which is what makes revival and the manual session refresh real in mock
 * mode instead of returning an empty transcript.
 */
const mockSessionHistories = new Map<string, Json[]>();

function recordMockUpdate(sessionId: string, update: Json): void {
  let history = mockSessionHistories.get(sessionId);
  if (!history) {
    history = [];
    mockSessionHistories.set(sessionId, history);
  }
  history.push(update);
}

/**
 * The app side of a loopback pair whose far side is a scenario-driven
 * FakeAgent. One per task, same as a spawned process.
 */
export function createMockAgentTransport(): AgentTransport {
  const [appSide, agentSide] = createLoopbackPair();
  attachScenarioAgent(agentSide);
  return appSide;
}

function attachScenarioAgent(agentSide: LoopbackTransport): void {
  const agent = new FakeAgent(agentSide);
  let currentAbort: AbortController | null = null;

  agent.onNewSession = async () => ({
    sessionId: `mock_session_${++mockSessionCounter}`,
  });

  agent.onLoadSession = async (params) => {
    for (const update of mockSessionHistories.get(params.sessionId) ?? []) {
      agent.update(params.sessionId, update);
    }
    return {};
  };

  agent.onCancel = () => currentAbort?.abort();

  agent.onPrompt = async (params) => {
    const text = promptText(params);
    const config = configFromPrompt(text) ?? activeConfig;
    const factory = scenarioRegistry.get(config.scenario)!;
    const scenario: MockScenario = factory(config.options);

    // History mirrors what a real harness persists: the prompt replays as a
    // single user_message_chunk, then the turn's updates in order.
    recordMockUpdate(params.sessionId, {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    });

    const abort = new AbortController();
    currentAbort = abort;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (abort.signal.aborted) return resolve();
        const timer = setTimeout(resolve, ms);
        abort.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    try {
      const result = await scenario({
        sessionId: params.sessionId,
        promptText: text,
        emit: (update) => {
          recordMockUpdate(params.sessionId, update);
          agent.update(params.sessionId, update);
        },
        sleep,
        signal: abort.signal,
      });
      return (
        result ?? {
          stopReason: abort.signal.aborted ? "cancelled" : "end_turn",
        }
      );
    } finally {
      if (currentAbort === abort) currentAbort = null;
    }
  };
}

/**
 * The MCP seam's stand-in: never advertises an `mcpServer`, so the session
 * simply runs without app tools — the mock agent doesn't call any.
 */
export function createMockMcpEndpoint(): McpEndpoint {
  return {
    async start() {},
    mcpServer: undefined,
    onRequest() {
      return () => {};
    },
    async close() {},
  };
}

declare global {
  interface Window {
    __mockAgent?: {
      configure: (config: MockAgentConfig) => void;
      register: (name: string, factory: MockScenarioFactory) => void;
      scenarios: () => string[];
      /** Collection row counts — DOM-independent, so specs can assert
       *  transcript size regardless of how the transcript renders. */
      stats: () => Promise<{ tasks: number; turns: number; entries: number }>;
    };
  }
}

if (MOCK_AGENT_MODE && typeof window !== "undefined") {
  window.__mockAgent = {
    configure: configureMockAgent,
    register: registerMockScenario,
    scenarios: () => [...scenarioRegistry.keys()],
    // Dynamic import keeps the collections out of this module's static
    // graph — only mock-mode sessions in a running app ever call this.
    stats: async () => {
      const collections = await import("./agent-collections");
      return {
        tasks: collections.agentTasksCollection.toArray.length,
        turns: collections.agentTurnsCollection.toArray.length,
        entries: collections.agentEntriesCollection.toArray.length,
      };
    },
  };
  // eslint-disable-next-line no-console
  console.info(
    "[mock-harness] VITE_AGENT_MOCK on — agent transports are mocked",
  );
}
