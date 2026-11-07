/**
 * The lease plugin in a live editor: others' leased blocks drawn with the
 * holder's colour and label (an agent with its marker), read-only through
 * `filterTransaction` — inside them and, for a structural edit, right next
 * to them — while adoptions pass; own leases drawn faintly and editable;
 * ranges kept through edits elsewhere; and the attach manager putting the
 * plugin on with presence.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { ADOPTION_TRANSACTION_META } from "@/components/editor/adopt-external-content";
import { createDocumentPort, type SyncLeaseView } from "../document-channel";
import { createLeasePlugin, leasePluginKey } from "./lease-editor";
import { createPresenceEditors } from "./presence-editor";

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function makeEditor() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [StarterKit],
    content: "<h1>Title</h1><p>Alpha line.</p><p>Beta line.</p><p>Gamma line.</p>",
  });
  editors.push(editor);
  return editor;
}

const view = (blockIndex: number, extra: Partial<SyncLeaseView> = {}): SyncLeaseView => ({
  blockIndex,
  holderId: "dev-ada",
  name: "Ada",
  color: "#8e4ec6",
  mine: false,
  kind: "human",
  ...extra,
});

const show = (editor: Editor, views: SyncLeaseView[]) =>
  editor.view.dispatch(editor.state.tr.setMeta(leasePluginKey, views));

/** The position just inside top-level block `index`. */
const inside = (editor: Editor, index: number, offset = 1) => {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize;
  return pos + offset;
};

const text = (editor: Editor) => editor.state.doc.textContent;

describe("the lease plugin", () => {
  it("draws others' leases with their colour and label, an agent with its marker", () => {
    const editor = makeEditor();
    editor.registerPlugin(createLeasePlugin());
    show(editor, [view(1), view(3, { holderId: "dev-ada/t1", kind: "agent", harness: "claude" })]);
    const blocks = editor.view.dom.querySelectorAll(".sync-lease-block");
    expect(blocks).toHaveLength(2);
    expect((blocks[0] as HTMLElement).dataset.leaseHolder).toBe("dev-ada");
    const labels = [...editor.view.dom.querySelectorAll(".sync-lease-label")].map((el) => el.textContent);
    expect(labels).toEqual(["Ada is editing", "AIAda · claude is editing"]);
    expect(editor.view.dom.classList.contains("notefig-sync-leases")).toBe(true);
  });

  it("keeps typing out of a block someone else holds, and lets it in everywhere else", () => {
    const editor = makeEditor();
    editor.registerPlugin(createLeasePlugin());
    show(editor, [view(2)]);
    const before = text(editor);
    editor.view.dispatch(editor.state.tr.insertText("x", inside(editor, 2, 3)));
    expect(text(editor)).toBe(before);
    // A selection that reaches into it, deleted: refused.
    editor.view.dispatch(editor.state.tr.delete(inside(editor, 1, 2), inside(editor, 2, 3)));
    expect(text(editor)).toBe(before);
    // Typing at the end of the block above it is fine.
    const endOfAlpha = inside(editor, 2) - 2;
    editor.view.dispatch(editor.state.tr.insertText("!", endOfAlpha));
    expect(text(editor)).toContain("Alpha line.!");
  });

  it("stops typing in a held block before the browser draws it", () => {
    const editor = makeEditor();
    editor.registerPlugin(createLeasePlugin());
    show(editor, [view(2)]);
    editor.commands.setTextSelection(inside(editor, 2, 3));
    const event = new InputEvent("beforeinput", { inputType: "insertText", data: "x", cancelable: true, bubbles: true });
    editor.view.dom.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    editor.commands.setTextSelection(inside(editor, 1, 3));
    const elsewhere = new InputEvent("beforeinput", { inputType: "insertText", data: "x", cancelable: true, bubbles: true });
    editor.view.dom.dispatchEvent(elsewhere);
    expect(elsewhere.defaultPrevented).toBe(false);
  });

  it("refuses a structural edit next to a held block (the lease rule's neighbours), not further away", () => {
    const editor = makeEditor();
    editor.registerPlugin(createLeasePlugin());
    show(editor, [view(2)]);
    const count = editor.state.doc.childCount;
    // Splitting the block right above it (Enter at its end) adds a block
    // next to the held one: refused.
    editor.view.dispatch(editor.state.tr.split(inside(editor, 2) - 2));
    expect(editor.state.doc.childCount).toBe(count);
    // Splitting the title, two blocks away: fine.
    editor.view.dispatch(editor.state.tr.split(inside(editor, 0, 3)));
    expect(editor.state.doc.childCount).toBe(count + 1);
  });

  it("lets adoptions through (merged or gated content), and keeps the range on the block through edits above", () => {
    const editor = makeEditor();
    editor.registerPlugin(createLeasePlugin());
    show(editor, [view(2)]);
    editor.view.dispatch(
      editor.state.tr.insertText("remote ", inside(editor, 2)).setMeta(ADOPTION_TRANSACTION_META, true),
    );
    expect(text(editor)).toContain("remote Beta line.");
    editor.view.dispatch(editor.state.tr.insertText("Longer ", inside(editor, 1)));
    const [range] = leasePluginKey.getState(editor.state)!.readOnly;
    expect(range.from).toBe(inside(editor, 2) - 1);
    expect(editor.state.doc.nodeAt(range.from)?.textContent).toBe("remote Beta line.");
  });

  it("draws this device's own leases faintly and leaves them editable", () => {
    const editor = makeEditor();
    editor.registerPlugin(createLeasePlugin());
    show(editor, [view(1, { mine: true })]);
    expect(editor.view.dom.querySelectorAll(".sync-lease-mine")).toHaveLength(1);
    expect(editor.view.dom.querySelector(".sync-lease-label")).toBeNull();
    editor.view.dispatch(editor.state.tr.insertText("x", inside(editor, 1, 2)));
    expect(text(editor)).toContain("Axlpha");
  });

  it("goes on and off with presence, following the channel's leases", async () => {
    const editor = makeEditor();
    let enabled = true;
    const port = createDocumentPort("/ws/a.md");
    const manager = createPresenceEditors({
      workspacePath: "/ws",
      editors: { paths: () => ["/ws/a.md"], markdownEditor: () => editor },
      enabled: () => enabled,
      openPort: () => port,
    });
    manager.reconcile();
    port.leases.set([view(1)]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leasePluginKey.getState(editor.state)?.readOnly).toHaveLength(1);
    enabled = false;
    manager.reconcile();
    expect(leasePluginKey.getState(editor.state)).toBeUndefined();
  });
});
