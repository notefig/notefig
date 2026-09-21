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
import {
  isAgentRecording,
  type AgentRecording,
  type RecordedEvent,
} from "@/components/debug-panel-recording";

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
  /** The app task this agent serves (the key the recorder / MCP loopback
   *  use); "" for a bare FakeAgent outside the harness. */
  taskId: string;
  /** The `cwd` the app passed on session/new — the live workspace path. */
  workspacePath: string;
  /** Concatenated text blocks of the prompt that started this turn. */
  promptText: string;
  /** The prompt's content blocks verbatim (text + resource_link parts). */
  prompt: Json[];
  /** Emit one `session/update` notification to the client. */
  emit: (update: Json) => void;
  /** Abort-aware delay; 0 still yields a macrotask so the UI breathes. */
  sleep: (ms: number) => Promise<void>;
  /** Send a client-directed request (fs/*, request_permission) and await
   *  the reply — the write half is how rewrite scenarios reach
   *  writeWorkspaceTextFile through the real client, same as an adapter. */
  request: (method: string, params: Json) => Promise<Json>;
  /**
   * Call the app's own MCP tool server the way a harness does — a JSON-RPC
   * request over the task's (loopback) McpEndpoint, answered by the real
   * handler with the real tools (widget_respond, author_blob, history_*…).
   * `mcp.call("tools/call", { name, arguments })` is the common form.
   */
  mcp: { call: (method: string, params: Json) => Promise<Json> };
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

// ─── Replay: a recording, played back ───────────────────────────────────────

export type ReplayOptions = {
  /** A recording from the debug panel's "Recording" button (debug-panel-recording.ts),
   *  or a fixture file in tests/agent/fixtures/). */
  recording: AgentRecording;
  /**
   * Which recorded turn this prompt plays. Default: the next unplayed turn
   * of the recording for this session, in order — so a test that sends the
   * recording's prompts in sequence gets the recording back in sequence.
   * Once every turn has played, further prompts replay the last one.
   */
  turn?: number;
  /**
   * Pacing. 0 (default) plays flat out, yielding a macrotask between events
   * so the UI streams; 1 reproduces the recorded gaps; n plays them n×
   * faster. Every gap is capped by `maxDelayMs`.
   */
  speed?: number;
  /** Cap on one inter-event gap when pacing (default 1500ms) — recordings
   *  of a thinking model have multi-second silences nobody wants to sit
   *  through in a test. */
  maxDelayMs?: number;
};

/** Per-session, per-recording cursor for the default "next turn" rule. */
const replayCursors = new Map<string, number>();

function replayCursorKey(sessionId: string, recording: AgentRecording) {
  return `${sessionId}\u0000${recording.taskId}\u0000${recording.recordedAt}`;
}

/**
 * Substitute the live workspace path for the recorded one wherever it
 * appears in an event (tool locations, fs/* paths, diff paths, resource
 * URIs) — a deep walk over strings, so the JSON shape is untouched.
 */
export function remapWorkspacePath<T>(value: T, from: string, to: string): T {
  if (!from || from === to) return value;
  const walk = (node: Json): Json => {
    if (typeof node === "string") {
      return node.includes(from) ? node.split(from).join(to) : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, Json> = {};
      for (const [key, inner] of Object.entries(node)) out[key] = walk(inner);
      return out;
    }
    return node;
  };
  return walk(value) as T;
}

/**
 * Play one recorded turn through the real client: updates are emitted as
 * recorded; agent→client requests (permission, fs/*) are made for real and
 * the LIVE app answers them (the recorded reply is not imposed — the
 * permission card the test clicks is the real one); MCP calls run the real
 * tools through the mock loopback. The recorded stopReason/error ends the
 * turn; a cancel mid-replay stops it with "cancelled".
 */
export function replay(options: Json): MockScenario {
  const { recording, turn: turnIndex, speed = 0, maxDelayMs = 1500 } =
    (options ?? {}) as Partial<ReplayOptions>;
  if (!isAgentRecording(recording)) {
    throw new Error(
      "replay scenario needs options.recording in the notefig-agent-recording format",
    );
  }
  if (recording.turns.length === 0) {
    throw new Error("replay scenario: the recording has no turns");
  }

  return async (ctx) => {
    const turn = recording.turns[resolveReplayTurn(ctx.sessionId, recording, turnIndex)];
    const player = new ReplayPlayer(ctx, recording, { speed, maxDelayMs });
    for (const event of turn.events as RecordedEvent[]) {
      if (ctx.signal.aborted) return { stopReason: "cancelled" };
      await player.play(event);
    }
    if (ctx.signal.aborted) return { stopReason: "cancelled" };
    if (turn.error) throw new Error(turn.error.message);
    return { stopReason: turn.stopReason ?? "end_turn" };
  };
}

/** The default "next unplayed turn" rule, with an explicit index override. */
function resolveReplayTurn(
  sessionId: string,
  recording: AgentRecording,
  explicit: number | undefined,
): number {
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 0 || explicit >= recording.turns.length) {
      throw new Error(
        `replay scenario: turn ${explicit} is out of range (recording has ${recording.turns.length} turns)`,
      );
    }
    return explicit;
  }
  const key = replayCursorKey(sessionId, recording);
  const index = Math.min(
    replayCursors.get(key) ?? 0,
    recording.turns.length - 1,
  );
  replayCursors.set(key, index + 1);
  return index;
}

/** Plays one recorded event against the live session, paced. */
class ReplayPlayer {
  private previousAt = 0;

  constructor(
    private readonly ctx: MockTurnContext,
    private readonly recording: AgentRecording,
    private readonly pace: { speed: number; maxDelayMs: number },
  ) {}

  private remap<T>(value: T): T {
    return remapWorkspacePath(
      value,
      this.recording.workspacePath,
      this.ctx.workspacePath,
    );
  }

  private withSession(params: Json): Json {
    return params && typeof params === "object" && !Array.isArray(params)
      ? { ...params, sessionId: this.ctx.sessionId }
      : params;
  }

  private gap(at: number): number {
    const { speed, maxDelayMs } = this.pace;
    const gap =
      speed > 0 ? Math.min((at - this.previousAt) / speed, maxDelayMs) : 0;
    this.previousAt = at;
    return Math.max(0, gap);
  }

  async play(event: RecordedEvent): Promise<void> {
    await this.ctx.sleep(this.gap(event.at));
    if (this.ctx.signal.aborted) return;
    switch (event.kind) {
      case "update":
        this.ctx.emit(this.remap(event.update));
        return;
      case "request":
        await this.ctx.request(
          event.method,
          this.withSession(this.remap(event.params)),
        );
        return;
      case "mcp":
        try {
          await this.ctx.mcp.call(event.method, this.remap(event.params));
        } catch (error) {
          // A recorded call that fails live (a tool the app no longer has,
          // a blob path that doesn't exist here) must not derail the
          // replay — the transcript entry for it already arrived as an
          // ACP update. Surface it, keep going.
          console.warn("[mock-harness] replayed MCP call failed:", error);
        }
    }
  }
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
  ["replay", (options) => replay(options)],
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
/** The most recent `session/prompt` params any mock agent received — the
 *  prompt as it went on the wire (text + resource_link parts), for specs
 *  that assert what the composer/widget actually sent. */
let lastMockPromptParams: Json = null;

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
export function createMockAgentTransport(
  spec: { taskId?: string } = {},
): AgentTransport {
  const [appSide, agentSide] = createLoopbackPair();
  attachScenarioAgent(agentSide, spec.taskId ?? "");
  return appSide;
}

function attachScenarioAgent(
  agentSide: LoopbackTransport,
  taskId: string,
): void {
  const agent = new FakeAgent(agentSide);
  let currentAbort: AbortController | null = null;
  // The live workspace path arrives as session/new's `cwd` (session/load
  // carries it too); scenarios need it to address files like a real
  // harness would.
  let workspacePath = "";

  agent.onNewSession = async (params) => {
    workspacePath = params?.cwd ?? "";
    return { sessionId: `mock_session_${++mockSessionCounter}` };
  };

  agent.onLoadSession = async (params) => {
    workspacePath = params?.cwd ?? workspacePath;
    for (const update of mockSessionHistories.get(params.sessionId) ?? []) {
      agent.update(params.sessionId, update);
    }
    return {};
  };

  agent.onCancel = () => currentAbort?.abort();

  agent.onPrompt = async (params) => {
    lastMockPromptParams = params;
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
        taskId,
        workspacePath,
        promptText: text,
        prompt: params?.prompt ?? [],
        emit: (update) => {
          recordMockUpdate(params.sessionId, update);
          agent.update(params.sessionId, update);
        },
        sleep,
        signal: abort.signal,
        request: (method, params) => agent.request(method, params),
        mcp: { call: (method, params) => callMockMcp(taskId, method, params) },
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

// ─── The MCP loopback ───────────────────────────────────────────────────────

type MockMcpLoopback = McpEndpoint & {
  /** Deliver one request line as a harness would; resolves with the
   *  handler's response line. */
  call(line: string): Promise<string>;
};

/** Live mock endpoints by taskId — the scenario agent reaches its task's
 *  tool server through here (there is no process or socket between them). */
const mockMcpEndpoints = new Map<string, MockMcpLoopback>();
let mockMcpRequestId = 0;

/**
 * The MCP seam's stand-in: an in-memory endpoint the scenario agent can
 * call directly. It never advertises an `mcpServer` (nothing spawns), but
 * the real request handler is attached to it by AgentTask.start exactly as
 * in production, so `tools/call` runs the real tools — which is what lets
 * recordings of widget_respond / author_blob / history_* turns replay.
 */
export function createMockMcpEndpoint(
  spec: { taskId?: string } = {},
): McpEndpoint {
  let handler:
    | ((line: string, respond: (line: string) => void) => void)
    | null = null;
  const endpoint: MockMcpLoopback = {
    async start() {},
    mcpServer: undefined,
    onRequest(callback) {
      handler = callback;
      return () => {
        if (handler === callback) handler = null;
      };
    },
    call(line) {
      return new Promise<string>((resolve, reject) => {
        if (!handler) {
          reject(new Error("mock MCP endpoint has no handler attached"));
          return;
        }
        handler(line, resolve);
      });
    },
    async close() {
      if (spec.taskId && mockMcpEndpoints.get(spec.taskId) === endpoint) {
        mockMcpEndpoints.delete(spec.taskId);
      }
    },
  };
  if (spec.taskId) mockMcpEndpoints.set(spec.taskId, endpoint);
  return endpoint;
}

/** One JSON-RPC MCP request against a task's mock endpoint; the `result`
 *  comes back, an `error` throws (same contract a harness sees). */
async function callMockMcp(
  taskId: string,
  method: string,
  params: Json,
): Promise<Json> {
  const endpoint = mockMcpEndpoints.get(taskId);
  if (!endpoint) {
    throw new Error(`no mock MCP endpoint for task "${taskId || "(none)"}"`);
  }
  const id = ++mockMcpRequestId;
  const reply = JSON.parse(
    await endpoint.call(JSON.stringify({ jsonrpc: "2.0", id, method, params })),
  );
  if (reply.error) {
    throw new Error(
      `MCP ${method} failed: ${reply.error.message ?? JSON.stringify(reply.error)}`,
    );
  }
  return reply.result;
}

declare global {
  interface Window {
    __mockAgent?: {
      configure: (config: MockAgentConfig) => void;
      register: (name: string, factory: MockScenarioFactory) => void;
      scenarios: () => string[];
      /** Collection row counts — DOM-independent, so specs can assert
       *  transcript size regardless of how the transcript renders. */
      stats: () => Promise<{
        tasks: number;
        turns: number;
        /** Turns that reached completed / error / cancelled. */
        settledTurns: number;
        entries: number;
      }>;
      /** The last `session/prompt` params a mock agent received. */
      lastPrompt: () => Json;
      /** `configure({ scenario: "replay", options })` with validation —
       *  the recording is what the debug panel's Recording button copies. */
      replay: (
        recording: AgentRecording,
        options?: Omit<ReplayOptions, "recording">,
      ) => void;
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
      const turns = collections.agentTurnsCollection.toArray;
      return {
        tasks: collections.agentTasksCollection.toArray.length,
        turns: turns.length,
        settledTurns: turns.filter((turn) =>
          ["completed", "error", "cancelled"].includes(turn.status),
        ).length,
        entries: collections.agentEntriesCollection.toArray.length,
      };
    },
    lastPrompt: () => lastMockPromptParams,
    replay: (recording, options) =>
      configureMockAgent({
        scenario: "replay",
        options: { ...options, recording },
      }),
  };
  // eslint-disable-next-line no-console
  console.info(
    "[mock-harness] VITE_AGENT_MOCK on — agent transports are mocked",
  );
}
