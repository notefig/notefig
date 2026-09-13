/**
 * The minimal host: enough construction to stand up a real NotefigAcpClient
 * and drive one turn, with no app and no webview.
 *
 * This is deliberately not the service and not the core. There is no
 * workspace registry, no collections, no database, and no MCP tool registry
 * — those arrive with the core extraction (MET-183) and the service split
 * (MET-185). What this proves, and all it proves, is that the orchestration
 * layer runs outside Vite: the ACP client here is the same class the desktop
 * app runs, over a transport that is a plain Node child process.
 */
import {
  NotefigAcpClient,
  type AgentTransport,
} from '../agent';
import {
  BUILT_IN_HARNESSES,
  composePrompt,
  type HarnessDefinition,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '../shared';
import { createAcpFileSystem, type ServiceHost } from '../core';
import { createHeadlessHost } from './headless-host';

/** How long a cancelled turn gets to end through the protocol before the
 *  harness tree is taken down underneath it. */
const CANCEL_GRACE_MS = 3_000;

/** Where a turn ended, as ACP reports it. */
export type TurnOutcome = { stopReason: string };

export type HeadlessSessionSpec = {
  /**
   * Identity for this run, minted by the caller with the shared
   * `newTaskId()`. Nothing persists it yet — headless has no collections or
   * KV store until the core extraction (MET-183) gives it one — but a run
   * that is already named in the app's id space is a run the app can adopt
   * later, rather than one that has to be retrofitted with an identity.
   */
  taskId: string;
  harnessId: string;
  /**
   * The host this turn runs against. Defaults to the CLI's own headless
   * host; injectable so a test can vary a single surface without rebuilding
   * the world.
   */
  host?: ServiceHost;
  /** Absolute, already-verified workspace directory. */
  workspacePath: string;
  prompt: string;
  /** Streamed protocol notifications, in arrival order. */
  onUpdate: (notification: SessionNotification) => void;
  /** Adapter stderr — out-of-band, never part of the JSON-RPC stream. */
  onDiagnostic?: (line: string) => void;
  /** Injectable so tests can drive a scripted agent instead of a process. */
  createTransport?: (harness: HarnessDefinition) => AgentTransport;
  /** Abort the turn: ACP `session/cancel` first, then a forced teardown. */
  signal?: AbortSignal;
};

export class HeadlessSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HeadlessSessionError';
  }
}

/** The turn was aborted by the caller. Distinct from a failure so a CLI can
 *  report "cancelled" and pick the right exit code. */
export class TurnCancelledError extends HeadlessSessionError {
  constructor() {
    super('the turn was cancelled');
    this.name = 'TurnCancelledError';
  }
}

/**
 * Headless permission policy for this ticket: decline everything.
 *
 * A background host must never grant a permission the user did not declare
 * (standing project decision — headless never auto-approves beyond declared
 * trust). The durable pending-request queue and the per-workspace trust tier
 * that let a human answer later are MET-189; until they exist, the only safe
 * answer is no. Declining is visible in the transcript, so a turn that needs
 * a permission fails loudly rather than silently doing less than asked.
 */
function createDecliningPermissionRequester(
  onDeclined: (toolName: string) => void,
) {
  return {
    async request(
      request: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      onDeclined(request.toolCall?.title ?? 'a tool call');
      // "cancelled" is the ACP outcome for "no option was chosen"; picking a
      // reject option id would be guessing at this adapter's option set.
      return { outcome: { outcome: 'cancelled' } };
    },
  };
}

export function findHarness(harnessId: string): HarnessDefinition {
  const harness = BUILT_IN_HARNESSES.find((h) => h.id === harnessId);
  if (!harness) {
    const known = BUILT_IN_HARNESSES.map((h) => h.id).join(', ');
    throw new HeadlessSessionError(
      `unknown harness "${harnessId}". Available: ${known}`,
    );
  }
  return harness;
}

/**
 * Run exactly one turn to completion and tear the harness down.
 *
 * Returns the ACP stop reason. Throws HeadlessSessionError for anything a
 * user can act on (unknown harness, missing binary, protocol refusal); the
 * caller renders the message, not a stack.
 */
export async function runHeadlessTurn(
  spec: HeadlessSessionSpec,
): Promise<TurnOutcome> {
  const harness = findHarness(spec.harnessId);
  const host =
    spec.host ?? createHeadlessHost({ onDiagnostic: spec.onDiagnostic });
  const proc = host.platform.proc;
  if (!proc) {
    // The surface's absence is the capability answer — asked before acting,
    // so this is a sentence rather than an exception from inside the core.
    throw new HeadlessSessionError(
      'this host cannot start harness processes',
    );
  }
  const transport =
    spec.createTransport?.(harness) ??
    proc.createAgentTransport({
      taskId: spec.taskId,
      harness,
      workspacePath: spec.workspacePath,
    });

  if (spec.onDiagnostic) transport.onDiagnostic?.(spec.onDiagnostic);

  const client = new NotefigAcpClient({
    // One connection per task, same as the desktop.
    taskId: spec.taskId,
    transport,
    permissionBroker: createDecliningPermissionRequester((toolName) =>
      spec.onDiagnostic?.(
        `permission declined (headless host cannot grant): ${toolName}`,
      ),
    ),
    onSessionUpdate: spec.onUpdate,
    // One bridge, defined in the core: the containment guard, the relative
    // path rules and the line/limit window are protocol decisions, so both
    // hosts get them from the same function rather than each implementing
    // their own (they had already drifted three ways).
    fs: createAcpFileSystem(host.platform.fs, {
      workspacePath: spec.workspacePath,
      path: host.path,
    }),
  });

  // A transport death mid-turn would otherwise leave `prompt()` pending
  // forever — the ACP library has no timeout of its own.
  const died = new Promise<never>((_, reject) => {
    transport.onClose((error) =>
      reject(error ?? new HeadlessSessionError('the harness exited unexpectedly')),
    );
  });
  // Nothing awaits `died` unless it loses a race; without this an early
  // rejection is an unhandled rejection.
  died.catch(() => undefined);

  // Before a session exists there is nothing to `session/cancel`, but an
  // adapter can still wedge during `initialize` — so the startup phase races
  // against a plain abort. Teardown is the `finally`'s job either way.
  const { promise: abortedEarly, dispose: disposeEarlyAbort } = abortRace(
    spec.signal,
    () => undefined,
    0,
  );

  try {
    if (spec.signal?.aborted) throw new TurnCancelledError();
    await transport.start();
    await Promise.race([client.connect(), died, abortedEarly]);

    // No MCP servers: app tools are not part of this ticket.
    const session = await Promise.race([
      client.newSession(transport.agentCwd ?? spec.workspacePath, []),
      died,
      abortedEarly,
    ]);
    disposeEarlyAbort();

    // Cancellation is only meaningful once there is a session to cancel.
    // ACP `session/cancel` asks the harness to end the turn, which makes
    // `prompt()` resolve with a "cancelled" stop reason — the graceful path.
    // The grace timer is the backstop for an adapter that ignores it: the
    // `finally` below then kills the process tree regardless.
    const { promise: cancelled, dispose: disposeCancel } = abortRace(
      spec.signal,
      () => void client.cancel(session.sessionId).catch(() => undefined),
    );

    // The same composer the panel uses. No context parts here — this host
    // has no editor to draw them from — but going through it means a
    // headless prompt is shaped by one function, not by a second hand-rolled
    // block array that can drift from it.
    const blocks = composePrompt({
      text: spec.prompt,
      capabilities: { embeddedContext: false },
    });
    try {
      const response = await Promise.race([
        client.prompt(session.sessionId, blocks),
        died,
        cancelled,
      ]);
      return { stopReason: String(response.stopReason) };
    } finally {
      disposeCancel();
    }
  } catch (error: any) {
    if (error instanceof HeadlessSessionError) throw error;
    throw new HeadlessSessionError(error?.message ?? String(error));
  } finally {
    disposeEarlyAbort();
    // Always: a thrown, cancelled, or failed turn must not leave the harness
    // tree running. close() kills the whole process group, not just the
    // child we spawned.
    await transport.close();
  }
}

/**
 * Turn an AbortSignal into a promise that rejects once the abort has had its
 * graceful chance. `onAbort` runs immediately (the protocol-level cancel);
 * the rejection lands `graceMs` later, so a harness that honours the cancel
 * wins the race and reports its own stop reason. A grace of 0 is the
 * no-session case, where there is nothing to ask nicely.
 */
function abortRace(
  signal: AbortSignal | undefined,
  onAbort: () => void,
  graceMs: number = CANCEL_GRACE_MS,
): { promise: Promise<never>; dispose: () => void } {
  let dispose = () => undefined as void;
  const promise = new Promise<never>((_, reject) => {
    if (!signal) return; // never settles; harmless in a race
    let timer: NodeJS.Timeout | undefined;
    const handler = () => {
      onAbort();
      timer = setTimeout(() => reject(new TurnCancelledError()), graceMs);
      // Don't let the grace timer hold the process open on its own.
      timer.unref?.();
    };
    if (signal.aborted) handler();
    else signal.addEventListener('abort', handler, { once: true });
    dispose = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', handler);
    };
  });
  // A rejection that loses the race must not surface as unhandled.
  promise.catch(() => undefined);
  return { promise, dispose };
}
