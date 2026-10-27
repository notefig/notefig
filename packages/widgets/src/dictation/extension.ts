/**
 * Dictation in a Tiptap editor: the place speech lands. The app's dictation
 * service owns the microphone, the model and the hold key; an editor with
 * this extension only offers itself as a target (`host.attach`) and, while
 * someone dictates into it, shows the words so far at the caret — phrases
 * already settled as plain text, the phrase still being spoken shimmering as
 * it's re-heard — and then inserts the final text.
 *
 * The contract with the service (`DictationHost` and the targets it
 * takes) is `@notefig/dictation`'s.
 *
 * The ghost is a decoration, never part of the document, so it can't be
 * saved, synced or undone. The final text goes in as one transaction, so one
 * undo removes the whole dictation.
 */
import { Extension } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import {
  fitDictation,
  type DictationHost,
  type DictationInsertion,
  type DictationTarget,
} from "@notefig/dictation";
import { mountVoiceWave } from "@notefig/ui/voice-wave";

interface GhostState {
  /** One per dictation: its DOM is built once and updated in place. */
  id: number;
  from: number;
  to: number;
  settled: string;
  live: string;
}

type GhostMeta = { set: GhostState } | { clear: true };

const dictationKey = new PluginKey<GhostState | null>("dictation");

function textAround(state: EditorState, from: number, to: number) {
  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);
  return {
    before: state.doc.textBetween($from.start(), from, "\n", " "),
    after: state.doc.textBetween(to, $to.end(), "\n", " "),
  };
}

const leadingSpace = (state: EditorState, ghost: GhostState) => {
  const { before } = textAround(state, ghost.from, ghost.to);
  return before !== "" && !/\s$/.test(before);
};

/**
 * The words so far at the caret, then the voice wave. Settled phrases read
 * as ordinary text; the live one shimmers like streaming agent output (the
 * app's `.shimmer`). The wave trails the words, at the edge where they grow,
 * so the text starts exactly where it will land and nothing moves when the
 * ghost gives way to it. Built once per dictation and updated in place: a
 * fresh element per update would restart the shimmer and the wave.
 *
 * While it shows, the editor's placeholder is hidden, and the composers
 * show their wave in their own chrome instead (styles.css).
 */
function createGhost(host: DictationHost) {
  const el = document.createElement("span");
  el.className = "dictation-ghost pointer-events-none";
  el.setAttribute("aria-hidden", "true");
  const lead = document.createTextNode("");
  const settled = document.createTextNode("");
  const live = document.createElement("span");
  live.className = "shimmer text-muted-foreground";
  const wave = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  wave.setAttribute(
    "class",
    "dictation-wave ms-[0.3em] me-[0.1em] inline-block size-[1.45em] align-[-0.35em] text-muted-foreground",
  );
  const stop = mountVoiceWave(wave, { level: host.level });
  el.append(lead, settled, live, wave);
  return {
    el,
    stop,
    render(ghost: GhostState, spaceBefore: boolean) {
      lead.data = spaceBefore && (ghost.settled || ghost.live) ? " " : "";
      settled.data = ghost.settled;
      live.textContent = ghost.settled && ghost.live ? ` ${ghost.live}` : ghost.live;
    },
  };
}

function createTarget(view: EditorView, nextId: () => number): DictationTarget {
  const dispatchGhost = (meta: GhostMeta) =>
    view.dispatch(view.state.tr.setMeta(dictationKey, meta).setMeta("addToHistory", false));

  return {
    hasFocus: () => view.hasFocus(),
    begin() {
      if (!view.editable) return null;
      const { from, to } = view.state.selection;
      dispatchGhost({ set: { id: nextId(), from, to, settled: "", live: "" } });
      const ghost = () => dictationKey.getState(view.state);
      return {
        preview(settled, live) {
          const current = ghost();
          if (current) dispatchGhost({ set: { ...current, settled, live } });
        },
        commit(text) {
          const current = ghost();
          if (!current || view.isDestroyed) return;
          const { before, after } = textAround(view.state, current.from, current.to);
          const fitted = fitDictation(before, after, text);
          const tr = view.state.tr.setMeta(dictationKey, { clear: true });
          if (fitted) {
            tr.insertText(fitted, current.from, current.to);
            tr.setSelection(TextSelection.create(tr.doc, current.from + fitted.length));
            tr.scrollIntoView();
          }
          view.dispatch(tr);
        },
        cancel() {
          if (ghost() && !view.isDestroyed) dispatchGhost({ clear: true });
        },
      };
    },
  };
}

export function dictationExtension(host: DictationHost) {
  let lastId = 0;
  // Each editor view's ghost for the dictation in progress (by ghost id).
  const ghosts = new WeakMap<EditorView, { id: number } & ReturnType<typeof createGhost>>();
  const stopping = new WeakMap<Node, () => void>();
  const ghostFor = (view: EditorView, ghost: GhostState) => {
    let entry = ghosts.get(view);
    if (entry?.id !== ghost.id) {
      entry = { id: ghost.id, ...createGhost(host) };
      ghosts.set(view, entry);
      stopping.set(entry.el, entry.stop);
    }
    entry.render(ghost, leadingSpace(view.state, ghost));
    return entry.el;
  };
  return Extension.create({
    name: "dictation",
    addProseMirrorPlugins() {
      return [
        new Plugin<GhostState | null>({
          key: dictationKey,
          state: {
            init: () => null,
            apply(tr, ghost, _old, state) {
              const meta = tr.getMeta(dictationKey) as GhostMeta | undefined;
              if (meta && "clear" in meta) return null;
              if (meta && "set" in meta) return meta.set;
              if (!ghost || !tr.docChanged) return ghost;
              // Edits made meanwhile (an agent writing, a remote change) move
              // where the dictation lands rather than strand it. If its spot
              // went away (the document was replaced: reloaded from disk),
              // it lands at the caret instead, not wherever the mapping
              // collapsed to.
              // Text inserted right at its edges stays outside it: a caret
              // stays a caret, a selection doesn't grow — or the commit
              // would replace what someone typed meanwhile.
              const collapsed = ghost.from === ghost.to;
              const from = tr.mapping.mapResult(ghost.from, collapsed ? -1 : 1);
              const to = collapsed ? from : tr.mapping.mapResult(ghost.to, -1);
              if (from.deleted && to.deleted) {
                return { ...ghost, from: state.selection.from, to: state.selection.to };
              }
              return { ...ghost, from: from.pos, to: Math.max(from.pos, to.pos) };
            },
          },
          props: {
            decorations(state) {
              const ghost = dictationKey.getState(state);
              if (!ghost) return null;
              return DecorationSet.create(state.doc, [
                // Keyed by dictation: ProseMirror keeps the one element,
                // which `update` below rewrites as the words change.
                Decoration.widget(ghost.to, (view) => ghostFor(view, ghost), {
                  side: 1,
                  key: `dictation-${ghost.id}`,
                  ignoreSelection: true,
                  // The ghost is gone for good: stop its wave.
                  destroy: (node) => stopping.get(node)?.(),
                }),
              ]);
            },
          },
          view(view) {
            const detach = host.attach(createTarget(view, () => ++lastId));
            return {
              update(view) {
                const ghost = dictationKey.getState(view.state);
                if (ghost && ghosts.get(view)?.id === ghost.id) ghostFor(view, ghost);
              },
              destroy: detach,
            };
          },
        }),
      ];
    },
  });
}
