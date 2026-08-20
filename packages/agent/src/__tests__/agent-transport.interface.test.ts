import { describe, it, expect } from "vitest";
import {
  AgentTransportError,
  transportToStreams,
  type AgentTransport,
  type Unsubscribe,
} from "../agent-transport.interface";
import { LoopbackTransport, createLoopbackPair } from "../loopback-transport";

describe("AgentTransportError", () => {
  it("uses the explicit message when given one", () => {
    const error = new AgentTransportError("spawn_failed", "no such binary");
    expect(error.message).toBe("no such binary");
    expect(error.type).toBe("spawn_failed");
  });

  it("derives a readable message from the type when none is given", () => {
    const error = new AgentTransportError("peer_disconnected");
    expect(error.message).toBe("peer disconnected");
  });
});

describe("transportToStreams", () => {
  /** Minimal transport whose close listeners we can fire more than once —
   *  the loopback pair guards against double-close, so it can't reach the
   *  readable's already-closed catch. */
  function manualTransport() {
    const lineListeners = new Set<(line: string) => void>();
    const closeListeners = new Set<() => void>();
    const transport: AgentTransport = {
      locus: "local",
      start: async () => {},
      send: () => {},
      onLine: (cb): Unsubscribe => {
        lineListeners.add(cb);
        return () => lineListeners.delete(cb);
      },
      onClose: (cb): Unsubscribe => {
        closeListeners.add(cb);
        return () => closeListeners.delete(cb);
      },
      close: async () => {},
    };
    return {
      transport,
      emitClose: () => {
        for (const cb of closeListeners) cb();
      },
    };
  }

  it("tolerates the transport signalling close twice (controller already closed)", async () => {
    const { transport, emitClose } = manualTransport();
    const { readable } = transportToStreams(transport);
    const reader = readable.getReader();
    emitClose();
    emitClose(); // second close must be swallowed, not thrown
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});

describe("LoopbackTransport edge cases", () => {
  it("delivers sends to the peer's line listeners", () => {
    const [a, b] = createLoopbackPair();
    const received: string[] = [];
    b.onLine((line) => received.push(line));
    a.send("hello");
    expect(received).toEqual(["hello"]);
  });

  it("send after close is a silent no-op", async () => {
    const [a, b] = createLoopbackPair();
    const received: string[] = [];
    b.onLine((line) => received.push(line));
    await a.close();
    a.send("late");
    expect(received).toEqual([]);
  });

  it("send with no peer attached is a silent no-op", () => {
    const lonely = new LoopbackTransport();
    expect(() => lonely.send("into the void")).not.toThrow();
  });
});
