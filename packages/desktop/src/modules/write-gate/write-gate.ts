/**
 * Write gates — `core.writeGate`: a seam in front of writes that come from
 * outside the user's own typing (an agent's ACP `fs/write_text_file`), so
 * a module can refuse one before anything is written, or report on it
 * after it lands, without the writer knowing who is asking.
 *
 * A gate wraps the write like middleware: it gets the write and a
 * `perform` that does it, and either throws before calling `perform`
 * (refused: nothing written — the error reaches the writer, e.g. the
 * harness, as the tool call's failure), or calls it and may then throw to
 * report something the writer must know (the error says the write landed).
 * A gate that has nothing to say for this write just calls `perform`.
 *
 * Gates run in registration order, each around the next. The writer (the
 * agent service) only calls `run`; the gates belong to the modules that
 * register them (sync's lease gate, MET-273) and are unregistered in
 * their `dispose`.
 */
import { defineModule } from "@notefig/core";

/** A write about to happen. */
export interface GatedWrite {
  workspacePath: string;
  /** Absolute path. */
  path: string;
  content: string;
  writer: { kind: "agent"; taskId: string; harness: string };
}

export type WriteGate = (write: GatedWrite, perform: () => Promise<void>) => Promise<void>;

export interface WriteGateApi {
  /** Add a gate; returns the unregister. */
  register(gate: WriteGate): () => void;
  /** Do `perform` through every gate. */
  run(write: GatedWrite, perform: () => Promise<void>): Promise<void>;
}

export function createWriteGate(): WriteGateApi {
  const gates: WriteGate[] = [];
  return {
    register(gate) {
      gates.push(gate);
      return () => {
        const at = gates.indexOf(gate);
        if (at >= 0) gates.splice(at, 1);
      };
    },
    run(write, perform) {
      const chain = [...gates];
      const step = (index: number): Promise<void> => {
        const gate = chain[index];
        if (!gate) return perform();
        let performed = false;
        return gate(write, () => {
          if (performed) return Promise.resolve();
          performed = true;
          return step(index + 1);
        });
      };
      return step(0);
    },
  };
}

declare module "@notefig/core" {
  interface CoreModules {
    writeGate: WriteGateApi;
  }
}

export const writeGateModule = defineModule({
  name: "writeGate",
  register: () => createWriteGate(),
});
