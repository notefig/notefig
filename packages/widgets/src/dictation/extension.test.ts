import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { DictationTarget } from "@notefig/dictation";
import { dictationExtension } from "./extension";

let editor: Editor | null = null;
afterEach(() => editor?.destroy());

function setup(html: string) {
  const targets: DictationTarget[] = [];
  editor = new Editor({
    extensions: [
      StarterKit,
      dictationExtension({
        attach(target) {
          targets.push(target);
          return () => targets.splice(targets.indexOf(target), 1);
        },
        level: () => 0,
      }),
    ],
    content: html,
  });
  return { editor, targets };
}

const ghost = () => editor!.view.dom.querySelector(".dictation-ghost");

describe("dictationExtension", () => {
  it("registers the editor as a target while it lives", () => {
    const { targets } = setup("<p>Hi</p>");
    expect(targets).toHaveLength(1);
    editor!.destroy();
    editor = null;
    expect(targets).toHaveLength(0);
  });

  it("shows the words so far as ghost text that isn't in the document", () => {
    const { editor, targets } = setup("<p>Notes</p>");
    editor.commands.setTextSelection(6);
    const insertion = targets[0].begin()!;
    insertion.preview("So far", "so good");
    expect(ghost()?.textContent).toBe(" So far so good");
    expect(ghost()?.querySelector(".shimmer")?.textContent).toBe(" so good");
    expect(editor.getText()).toBe("Notes");
    insertion.cancel();
    expect(ghost()).toBeNull();
    expect(editor.getText()).toBe("Notes");
  });

  it("updates the words in place, with the wave after them", () => {
    const { editor, targets } = setup("<p>Notes</p>");
    editor.commands.setTextSelection(6);
    const insertion = targets[0].begin()!;
    const first = ghost();
    insertion.preview("", "so");
    insertion.preview("", "so far");
    // The same element throughout, so the shimmer and the wave don't restart.
    expect(ghost()).toBe(first);
    expect(ghost()?.lastElementChild?.classList.contains("dictation-wave")).toBe(true);
    insertion.cancel();
  });

  it("inserts the final text in one undo step and puts the caret after it", () => {
    const { editor, targets } = setup("<p>Meeting notes.</p>");
    editor.commands.setTextSelection(15);
    const insertion = targets[0].begin()!;
    insertion.preview("", "Then ship");
    insertion.commit("Then ship it.");
    expect(editor.getText()).toBe("Meeting notes. Then ship it.");
    expect(ghost()).toBeNull();
    expect(editor.state.selection.from).toBe(15 + " Then ship it.".length);
    editor.commands.undo();
    expect(editor.getText()).toBe("Meeting notes.");
  });

  it("lands where it began even after edits before it", () => {
    const { editor, targets } = setup("<p>end</p>");
    editor.commands.setTextSelection(4);
    const insertion = targets[0].begin()!;
    editor.commands.insertContentAt(1, "the ");
    insertion.commit("Of it.");
    expect(editor.getText()).toBe("the end of it.");
  });

  it("keeps what was typed at the dictation point while dictating", () => {
    const { editor, targets } = setup("<p>Today:</p>");
    editor.commands.setTextSelection(7);
    const insertion = targets[0].begin()!;
    editor.commands.insertContentAt(7, " typed");
    insertion.commit("Spoken.");
    expect(editor.getText()).toBe("Today: Spoken typed");
  });

  it("doesn't grow a selection being dictated over with edits at its edges", () => {
    const { editor, targets } = setup("<p>one two three</p>");
    editor.commands.setTextSelection({ from: 5, to: 8 });
    const insertion = targets[0].begin()!;
    editor.commands.insertContentAt(8, "!");
    editor.commands.insertContentAt(5, "~");
    insertion.commit("2");
    expect(editor.getText()).toBe("one ~ 2! three");
  });

  it("lands at the caret when the document is replaced underneath it", () => {
    const { editor, targets } = setup("<p>Notes</p><p>Today:</p>");
    editor.commands.setTextSelection(14);
    const insertion = targets[0].begin()!;
    // A reload from disk: the whole document swapped, caret put back.
    editor.chain().setContent("<p>Notes</p><p>Today:</p>").setTextSelection(14).run();
    insertion.commit("Ship it.");
    expect(editor.getHTML()).toBe("<p>Notes</p><p>Today: Ship it.</p>");
  });

  it("does nothing in a read-only editor", () => {
    const { editor, targets } = setup("<p>Locked</p>");
    editor.setEditable(false);
    expect(targets[0].begin()).toBeNull();
  });
});
