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
 *   `sync:remote-applied`, `sync:overwritten` (a merge overwrote text;
 *   also kept in `overwrites()` until dismissed) and `sync:failsafe`.
 *   Sync itself listens to `files:written` (every app write, with its
 *   `source`) and `files:changed` (the watcher).
 * - Levels: `setPeersPresent(present)` is the machine's presence input
 *   (MET-272 calls it; tests force shared with it). The engine also goes
 *   shared on its own when the remote moves under local commits
 *   (`contention`), since that is when a merge is needed; solo never
 *   merges.
 * - Failsafe (decision 20): capabilities carry `failsafe` (reason and the
 *   recovery ref the local state was saved to first); the user resolves it
 *   with `acceptIncoming()` or `disable()`.
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
 * - Shared merge (MET-271, here): merges run only in the sync worker (the
 *   markdown merge is its `GitMergeDriver`). Merged content reaches an
 *   open editor through the documents write path as one diffed
 *   transaction, out of the undo history, caret kept; a document with
 *   unsaved edits has its editor text (after its save) merged in the
 *   worker and written back only while the editor still holds that text
 *   (`documents.editorText` / `write({expect})`), merged again from the
 *   snapshot if the user typed meanwhile. `incoming` carries the notice
 *   (`merged: true`).
 * - The merge's holder seam for MET-273: the worker's
 *   `SyncWorkerWiring.policy.holderFor(path)` returns a per-block holder
 *   (`BlockHolder` in `merge/merge.ts`, asked per overlapping run of base
 *   blocks) or null for the default (the side already on the branch).
 * - Presence (MET-272, here): each device publishes
 *   `refs/notefig/v1/presence/<deviceId>` → a JSON blob
 *   (`SyncPresencePayload`: user name and colour, the branch commit, carets
 *   as block + offset relative to that commit, its running agents with
 *   the document and block they work on), in a request of its own, never
 *   with a content push; on change at most once a second while shared
 *   (5 s solo), else as a heartbeat (12 s shared and focused, 40 s
 *   otherwise); deleted on close. The poll reads them; a device is live
 *   while its ref moved within `PRESENCE_STALE_MS` as observed locally
 *   (payload timestamps are never read). Another live device →
 *   `setPeersPresent(true)` → shared; none → solo. The worker maps the
 *   others' positions onto this clone's head (`merge/blocks.ts`); the
 *   engine sets each open document's `remoteCursors` only when they
 *   change. At the shared level the engine attaches the presence plugin
 *   (`engine/presence-editor.ts`) to the workspace's open markdown editors
 *   through `editor.registerPlugin`: it draws carets, selections and agent
 *   holders, and reports the local caret with `setCursor` (throttled).
 *   `sync.presence()` / `"sync:presence"` / `useSyncPresence` list the
 *   peers (`SyncPeer`, with a `holds` slot for MET-273);
 *   `identity()`/`setIdentity` are this device's name and colour.
 * - Leases (MET-273): `requestLease` runs the lease rule (one rule for
 *   humans and agents) against the next atomic push; `leases` drives the
 *   read-only decorations, drawn by the same plugin next to the holders;
 *   `SyncPeer.holds` fills the presence list's slot.
 */
export * from "./sync";
export * from "./sync-runtime";
export * from "./sync-machine";
export * from "./sync-config";
export * from "./document-channel";
export * from "./presence-identity";
export type * from "./sync-types";
