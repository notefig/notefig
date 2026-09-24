/**
 * The app's one global event bus — for the few moments a subsystem needs
 * to announce something without knowing who listens (a settled agent turn
 * → the unseen tracker). Typed by event name; listeners register once at
 * boot. Not a substitute for the collections, which remain the bus for
 * state: an event here is a moment, not a fact to query later.
 */
import type { AgentTurnStatus } from "@notefig/shared/agent";

export interface AppEvents {
  /** A prompt widget sent a prompt: a round began in a document. */
  "widget:round-started": {
    taskId: string;
    turnId: string;
    workspacePath: string;
    /** Absolute path of the document the widget lives in. */
    documentPath: string;
    /** The prompt as sent. */
    prompt: string;
  };
  /** A turn reached a terminal status. */
  "agent:turn-settled": {
    taskId: string;
    turnId: string;
    status: Extract<AgentTurnStatus, "completed" | "cancelled" | "error">;
    /** The one settle time every record of this turn shares: what the
     *  task row and the prompt round store, and what "seen as it landed"
     *  compares against — so no two listeners' clocks can disagree. */
    at: number;
  };
}

type Listener<K extends keyof AppEvents> = (detail: AppEvents[K]) => void;

const listeners = new Map<keyof AppEvents, Set<Listener<keyof AppEvents>>>();

export function emitAppEvent<K extends keyof AppEvents>(
  name: K,
  detail: AppEvents[K],
): void {
  for (const listener of listeners.get(name) ?? []) {
    (listener as Listener<K>)(detail);
  }
}

export function onAppEvent<K extends keyof AppEvents>(
  name: K,
  listener: Listener<K>,
): () => void {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(listener as Listener<keyof AppEvents>);
  return () => {
    set.delete(listener as Listener<keyof AppEvents>);
  };
}
