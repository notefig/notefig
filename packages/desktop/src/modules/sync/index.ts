/**
 * Sync mode (MET-266): a workspace kept in step with one branch of its git
 * remote. What the rest of the app imports; it loads no engine code.
 *
 * ## The API later phases build on
 *
 * - `core.workspace(ws).sync` (`WorkspaceSync`): `capabilities()` and
 *   `subscribe` for state (consumers read capabilities, never raw machine
 *   states), `enable`/`disable`/`verify`/`resume`/`syncNow`, and
 *   `document(path)`, the per-document channel below.
 * - Hooks (`CoreHookMap`): `sync:state`, `sync:committed`, `sync:pushed`,
 *   `sync:remote-applied`. Sync itself listens to `files:written` (every
 *   app write, with its `source`) and `files:changed` (the watcher).
 * - `core.syncRuntime`: loads the engine chunk and starts sync workers;
 *   the only door to either.
 *
 * ## The editor ↔ sync channel (`SyncDocumentChannel`)
 *
 * `core.workspace(ws).sync.document(path)` opens a typed, two-way link for
 * one document, built from an ordered stream (every value, in order,
 * bounded — the writer waits when the reader lags) and latest-value slots
 * (only the newest counts: cursors, presence, leases):
 *
 * ```ts
 * const channel = core.workspace(ws).sync.document(path);
 * for await (const event of channel.incoming) { … } // ordered, sync → editor
 * for await (const carets of channel.remoteCursors) { … } // latest value
 * channel.setCursor({ anchor, head });            // latest value, editor → sync
 * const lease = await channel.requestLease([2, 3]); // editor → sync
 * channel.close();
 * ```
 *
 * What each phase plugs in:
 *
 * - Solo (MET-270, here): `incoming` carries `applied` notices for remote
 *   content already adopted through the documents write path; nothing
 *   else is sent, `requestLease` grants everything, and no editor
 *   attaches — nothing new runs in the editor.
 * - Shared merge (MET-271): the worker's merge result arrives on
 *   `incoming` as content to apply as one transaction (adoption keeps the
 *   caret); a document with unsaved edits waits for its save and is
 *   re-merged in the worker instead of stopping at `diverged`.
 * - Presence (MET-272): the engine sets `remoteCursors` from presence refs
 *   and reads `setCursor` (throttled) into its own presence ref. The
 *   machine's `peers` event moves solo ↔ shared.
 * - Leases (MET-273): `requestLease` runs the lease rule (one rule for
 *   humans and agents) against the next atomic push; `leases` drives the
 *   read-only decorations.
 */
export * from "./sync";
export * from "./sync-runtime";
export * from "./sync-machine";
export * from "./sync-config";
export * from "./document-channel";
export type * from "./sync-types";
