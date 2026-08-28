/**
 * Per-path in-flight tracking for workspace text writes — the internal
 * serialization detail writeWorkspaceTextFile's contract reserved for when
 * concurrent same-file interleaving became a real problem. It did with
 * scratchpad promotion (MET-135): the rename must know no agent write is
 * still racing toward the old path. Leaf module so both the write
 * primitive (utils/file-sync) and the rename orchestrator (entities/tabs)
 * can import it without a cycle.
 */
const inFlightWrites = new Map<string, Promise<void>>();

/** Run `write`, serialized after any in-flight write to the same path. */
export function trackWorkspaceWrite(
  path: string,
  write: () => Promise<void>,
): Promise<void> {
  const previous = inFlightWrites.get(path) ?? Promise.resolve();
  const op = previous.catch(() => {}).then(write);
  const settled = op.catch(() => {});
  inFlightWrites.set(path, settled);
  void settled.then(() => {
    if (inFlightWrites.get(path) === settled) inFlightWrites.delete(path);
  });
  return op;
}

/** Resolves once every write in flight for `path` has landed (or failed). */
export function whenWorkspaceWritesSettled(path: string): Promise<void> {
  return inFlightWrites.get(path) ?? Promise.resolve();
}
