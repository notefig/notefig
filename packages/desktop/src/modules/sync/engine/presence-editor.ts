/**
 * The editor side of presence (MET-272): a ProseMirror plugin attached to
 * a sync workspace's open markdown editors only while the workspace is at
 * the shared level (`capabilities().presence`), through
 * `editor.registerPlugin`; detached when it leaves it. A regular or solo
 * workspace never loads it (it is in the engine chunk) or registers it.
 *
 * It does two things, both cheap on the main thread:
 *
 * - draws the others: their carets and selections in their colour with a
 *   name label, and their agents as holders of the block they're working
 *   in, with an agent marker. The positions come from the document's sync
 *   channel (`remoteCursors`, latest value), already mapped onto this
 *   clone's head by the worker; decorations are rebuilt only when that
 *   value changes, and otherwise mapped through local edits;
 * - reports the local caret (`setCursor`), throttled: a selection change
 *   only arms a timer, and the block position is computed when it fires.
 *
 * MET-273's leased blocks draw from the same channel (`leases`), next to
 * these holders.
 */
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorsApi } from "@/modules/editors";
import { path as pathutil } from "@/utils/path";
import type { SyncCursor, SyncDocumentPort, SyncRemoteCursor } from "../document-channel";
import { fromBlockPosition, toBlockPosition } from "../presence-position";

/** The local caret is reported at most this often. */
export const PRESENCE_CURSOR_THROTTLE_MS = 300;

interface PresencePluginState {
  cursors: SyncRemoteCursor[];
  decorations: DecorationSet;
}

export const presencePluginKey = new PluginKey<PresencePluginState>("syncPresence");

const tint = (color: string, alpha: number) =>
  `${color}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, "0")}`;

function label(text: string, color: string, agent: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = "sync-presence-label";
  el.setAttribute("contenteditable", "false");
  el.style.cssText =
    `position:absolute;left:-1px;bottom:100%;white-space:nowrap;pointer-events:none;` +
    `font:600 10px/14px var(--font-sans, system-ui);padding:0 4px;border-radius:3px 3px 3px 0;` +
    `color:#fff;background:${color};user-select:none;z-index:5;`;
  if (agent) {
    const badge = document.createElement("span");
    badge.className = "sync-presence-agent-badge";
    badge.textContent = "AI";
    badge.style.cssText =
      `display:inline-block;margin-right:3px;padding:0 2px;border-radius:2px;` +
      `background:#fff;color:${color};font-size:8px;line-height:11px;`;
    el.appendChild(badge);
  }
  el.appendChild(document.createTextNode(text));
  return el;
}

function caret(cursor: SyncRemoteCursor): HTMLElement {
  const el = document.createElement("span");
  el.className = "sync-presence-caret";
  el.dataset.holder = cursor.holderId;
  el.setAttribute("contenteditable", "false");
  el.style.cssText =
    `position:relative;display:inline;margin-left:-1px;margin-right:-1px;` +
    `border-left:2px solid ${cursor.color};pointer-events:none;`;
  el.appendChild(label(cursor.name, cursor.color, false));
  return el;
}

function agentMarker(cursor: SyncRemoteCursor): HTMLElement {
  const el = document.createElement("span");
  el.className = "sync-presence-agent";
  el.dataset.holder = cursor.holderId;
  el.setAttribute("contenteditable", "false");
  el.style.cssText = "position:relative;display:inline;pointer-events:none;";
  el.appendChild(label(cursor.name, cursor.color, true));
  return el;
}

function personDecorations(doc: PMNode, cursor: SyncRemoteCursor, at: number): Decoration[] {
  const out: Decoration[] = [];
  const head = cursor.head ? fromBlockPosition(doc, cursor.head) : null;
  if (head !== null && head !== at) {
    out.push(
      Decoration.inline(Math.min(at, head), Math.max(at, head), {
        class: "sync-presence-selection",
        style: `background-color:${tint(cursor.color, 0.22)}`,
      }),
    );
  }
  out.push(
    Decoration.widget(head ?? at, () => caret(cursor), {
      key: `caret:${cursor.holderId}:${cursor.name}:${cursor.color}`,
      side: 1,
      ignoreSelection: true,
    }),
  );
  return out;
}

function agentDecorations(doc: PMNode, cursor: SyncRemoteCursor, at: number): Decoration[] {
  const index = doc.resolve(at).index(0);
  let start = 0;
  for (let i = 0; i < index; i++) start += doc.child(i).nodeSize;
  const node = doc.child(index);
  return [
    Decoration.node(start, start + node.nodeSize, {
      class: "sync-presence-agent-block",
      "data-presence-holder": cursor.holderId,
      style: `box-shadow:-3px 0 0 ${cursor.color};background-color:${tint(cursor.color, 0.06)}`,
    }),
    Decoration.widget(node.isLeaf ? start : start + 1, () => agentMarker(cursor), {
      key: `agent:${cursor.holderId}:${cursor.name}:${cursor.color}`,
      side: -1,
      ignoreSelection: true,
    }),
  ];
}

/** The decorations for a set of remote carets in `doc`. */
export function presenceDecorations(doc: PMNode, cursors: SyncRemoteCursor[]): DecorationSet {
  const decorations: Decoration[] = [];
  for (const cursor of cursors) {
    const at = fromBlockPosition(doc, cursor.anchor);
    if (at === null) continue;
    decorations.push(
      ...(cursor.agent ? agentDecorations(doc, cursor, at) : personDecorations(doc, cursor, at)),
    );
  }
  return DecorationSet.create(doc, decorations);
}

const localCursor = (state: EditorState): SyncCursor => ({
  anchor: toBlockPosition(state.doc, state.selection.anchor),
  head: toBlockPosition(state.doc, state.selection.head),
});

/** The plugin. `onCursor` gets the local caret, throttled, while the
 *  editor has focus. */
export function createPresencePlugin(options: {
  onCursor(cursor: SyncCursor): void;
  setTimer?: (run: () => void, ms: number) => () => void;
}): Plugin<PresencePluginState> {
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const handle = setTimeout(run, ms);
      return () => clearTimeout(handle);
    });
  return new Plugin<PresencePluginState>({
    key: presencePluginKey,
    state: {
      init: () => ({ cursors: [], decorations: DecorationSet.empty }),
      apply(tr, value, _old, state) {
        const next = tr.getMeta(presencePluginKey) as SyncRemoteCursor[] | undefined;
        if (next) return { cursors: next, decorations: presenceDecorations(state.doc, next) };
        if (!tr.docChanged) return value;
        return { cursors: value.cursors, decorations: value.decorations.map(tr.mapping, tr.doc) };
      },
    },
    props: {
      decorations: (state) => presencePluginKey.getState(state)?.decorations,
    },
    view(view) {
      let cancel: (() => void) | null = null;
      const arm = (current: EditorView) => {
        if (cancel) return;
        cancel = setTimer(() => {
          cancel = null;
          if (current.hasFocus()) options.onCursor(localCursor(current.state));
        }, PRESENCE_CURSOR_THROTTLE_MS);
      };
      const onFocus = () => arm(view);
      view.dom.addEventListener("focus", onFocus);
      return {
        update(current, prev) {
          if (current.state.selection.eq(prev.selection) && current.state.doc === prev.doc) return;
          arm(current);
        },
        destroy() {
          cancel?.();
          view.dom.removeEventListener("focus", onFocus);
        },
      };
    },
  });
}

/** Where the remote carets come from and where the local one goes. */
interface Attachment {
  editor: Editor;
  port: SyncDocumentPort;
}

/**
 * Keeps the plugin on exactly the workspace's open markdown editors while
 * `enabled()`: `reconcile` attaches and detaches (called on level changes
 * and after each poll). One caret per device: the editor that reported
 * last holds it; the others' are cleared.
 */
export function createPresenceEditors(deps: {
  workspacePath: string;
  editors: Pick<EditorsApi, "markdownEditor" | "paths">;
  enabled(): boolean;
  openPort(path: string): SyncDocumentPort;
  /** The local caret moved (to publish sooner). */
  onCursor?(): void;
  setTimer?: (run: () => void, ms: number) => () => void;
}) {
  const root = pathutil.normalize(deps.workspacePath);
  const attached = new Map<string, Attachment>();

  const inWorkspace = (path: string) => {
    const relative = pathutil.relative(root, path);
    return relative !== undefined && relative !== "";
  };

  const report = (path: string, cursor: SyncCursor) => {
    for (const [other, { port }] of attached) {
      if (other !== path && port.cursor.get()) port.cursor.set(null);
    }
    attached.get(path)?.port.cursor.set(cursor);
    deps.onCursor?.();
  };

  /** Apply the channel's carets to the editor, as they change. */
  const follow = async (attachment: Attachment) => {
    for await (const cursors of attachment.port.remoteCursors) {
      const { editor } = attachment;
      if (editor.isDestroyed || attached.get(attachment.port.channel.path) !== attachment) break;
      editor.view.dispatch(
        editor.state.tr.setMeta(presencePluginKey, cursors).setMeta("addToHistory", false),
      );
    }
  };

  /** Notices on `incoming` are for other readers; keep the stream moving. */
  const drain = async (port: SyncDocumentPort) => {
    for await (const _ of port.channel.incoming) {
      // Content is already adopted through the documents write path.
    }
  };

  const attach = (path: string, editor: Editor) => {
    const port = deps.openPort(path);
    const attachment = { editor, port };
    attached.set(path, attachment);
    editor.registerPlugin(
      createPresencePlugin({
        onCursor: (cursor) => report(path, cursor),
        setTimer: deps.setTimer,
      }),
    );
    void follow(attachment);
    void drain(port);
  };

  const detach = (path: string) => {
    const attachment = attached.get(path);
    if (!attachment) return;
    attached.delete(path);
    if (!attachment.editor.isDestroyed) attachment.editor.unregisterPlugin(presencePluginKey);
    attachment.port.channel.close();
  };

  return {
    reconcile() {
      const wanted = new Map<string, Editor>();
      if (deps.enabled()) {
        for (const path of deps.editors.paths()) {
          const editor = deps.editors.markdownEditor(path);
          if (editor && !editor.isDestroyed && inWorkspace(path)) wanted.set(path, editor);
        }
      }
      for (const [path, { editor }] of [...attached]) {
        if (wanted.get(path) !== editor) detach(path);
      }
      for (const [path, editor] of wanted) {
        if (!attached.has(path)) attach(path, editor);
      }
    },
    /** Paths with the plugin on. */
    attached: () => [...attached.keys()],
    stop() {
      for (const path of [...attached.keys()]) detach(path);
    },
  };
}
