/**
 * The degradation contract: every editor-port member has a defined answer
 * under a host with no editor.
 *
 * This is a table over the port's own surface rather than a list of
 * hand-written cases, so adding a method to EditorContextPort without giving
 * it a headless answer fails here instead of surfacing later as a tool that
 * throws from inside the core on a CLI run.
 */
import { describe, expect, it } from "vitest";
import {
  detachedEditorContext,
  type EditorContextPort,
} from "../editor-context-port";

/** Every method on the port, with arguments that are valid but unanswerable
 *  when nothing is attached. */
const CALLS: Array<{
  name: keyof EditorContextPort;
  invoke: (port: EditorContextPort) => unknown;
}> = [
  { name: "openFiles", invoke: (p) => p.openFiles("/ws") },
  { name: "documentContext", invoke: (p) => p.documentContext("/ws/a.md", 0) },
  { name: "readRange", invoke: (p) => p.readRange("/ws/a.md", 0, 10) },
  { name: "blobTypes", invoke: (p) => p.blobTypes() },
];

describe("detachedEditorContext", () => {
  it("reports itself as unattached", () => {
    expect(detachedEditorContext.attached).toBe(false);
  });

  it("covers every method the port declares", () => {
    // Guards the table itself: a new port method must be added here, which is
    // what forces the "what does headless answer?" decision.
    const declared = Object.keys(detachedEditorContext).filter(
      (key) => key !== "attached",
    );
    expect(declared.sort()).toEqual(CALLS.map((c) => c.name).sort());
  });

  it.each(CALLS.map((c) => [c.name, c] as const))(
    "%s declines with null instead of throwing",
    async (_name, call) => {
      // Both sync and async members funnel through await, so one assertion
      // covers the whole surface.
      await expect(Promise.resolve(call.invoke(detachedEditorContext)))
        .resolves.toBeNull();
    },
  );
});
