/**
 * Page links (MET-78): "@" in ordinary document prose opens the shared file
 * popup and picking a file inserts a link — while inside a prompt draft the
 * widget's own mention suggestion still owns the trigger. Exercised inside
 * the app's real editor kit, like ai-prompt-node.test.ts.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { SuggestionProps } from "@tiptap/suggestion";
import { editorExtensions } from "@/components/editor/tiptap-editor-kit";
import {
  widgetRendererNodes,
  registerMentionService,
  promptDraftRange,
  PageLinkSuggestion,
  pageLinkLabel,
  type MentionCandidate,
  type MentionRow,
  type MentionService,
} from "@notefig/widgets";
import { pageLinkHref } from "@/components/editor/tiptap-link-utils";

const FILE = "/ws/docs/page.md";
const WS = "/ws";

const CANDIDATES: MentionCandidate[] = [
  { relativePath: "notes.md", title: "notes.md", path: "/ws/notes.md" },
  { relativePath: "docs/other.md", title: "other.md", path: "/ws/docs/other.md" },
];

const ROWS: MentionRow[] = CANDIDATES.map((file) => ({ kind: "file", file }));

function testService() {
  const onStart = vi.fn<(props: SuggestionProps<MentionRow>) => void>();
  const service: MentionService = {
    hasResults: () => true,
    search: () => ROWS,
    onStart,
    onUpdate: vi.fn(),
    onKeyDown: () => false,
    onExit: vi.fn(),
  };
  return { service, onStart };
}

let editor: Editor | null = null;
let unregister: (() => void) | null = null;

async function documentEditor(content: string): Promise<Editor> {
  const created = new Editor({
    extensions: [
      ...editorExtensions.filter((e) => e.name !== "aiPrompt"),
      ...widgetRendererNodes({ filePath: FILE, basePath: WS }),
      PageLinkSuggestion.configure({
        documentPath: FILE,
        buildHref: (relativePath) => pageLinkHref(FILE, WS, relativePath),
      }),
    ],
    content,
  });
  document.body.appendChild(created.view.dom);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return created;
}

afterEach(() => {
  unregister?.();
  unregister = null;
  editor?.view.dom.remove();
  editor?.destroy();
  editor = null;
});

/** Type `text` at `pos` (default: wherever TextSelection.near lands from
 *  the document end — the trailing paragraph), arming the suggestion. */
async function typeAt(target: Editor, text: string, pos?: number) {
  target.view.focus();
  const $pos = target.state.doc.resolve(
    pos ?? target.state.doc.content.size,
  );
  target.view.dispatch(
    target.state.tr
      .setSelection(TextSelection.near($pos))
      .insertText(text),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("page-link suggestion", () => {
  it("opens on @ in prose and inserts a link on pick", async () => {
    const { service, onStart } = testService();
    unregister = registerMentionService(FILE, service);
    editor = await documentEditor("<p>see</p>");

    await typeAt(editor, " @");
    expect(onStart).toHaveBeenCalledTimes(1);

    // onStart fires while items are still loading; the resolved rows
    // arrive through onUpdate.
    expect(service.onUpdate).toHaveBeenCalled();
    const updated = vi.mocked(service.onUpdate).mock.calls.at(-1)![0];
    expect(updated.items).toEqual(ROWS);
    const props = onStart.mock.calls[0][0];
    props.command(ROWS[0]);

    const html = editor.getHTML();
    expect(html).toContain('href="notes.md"');
    expect(html).toContain(">notes</a>");
    // The trailing space stays outside the link.
    expect(editor.state.doc.textContent).toBe("see notes ");
  });

  it("links same-directory targets relative to the containing file", async () => {
    const { service, onStart } = testService();
    unregister = registerMentionService(FILE, service);
    editor = await documentEditor("<p></p>");

    await typeAt(editor, "@");
    const props = onStart.mock.calls[0][0];
    props.command(ROWS[1]);

    expect(editor.getHTML()).toContain('href="other.md"');
  });

  it("does not trigger inside a code block", async () => {
    const { service, onStart } = testService();
    unregister = registerMentionService(FILE, service);
    editor = await documentEditor("<pre><code>x</code></pre>");

    // Explicitly inside the code block — the document end would land in
    // the trailing paragraph instead.
    let codeEnd = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "codeBlock") codeEnd = pos + 1 + node.content.size;
      return codeEnd < 0;
    });
    expect(codeEnd).toBeGreaterThan(-1);
    await typeAt(editor, " @", codeEnd);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("leaves the draft-scoped mention suggestion to insert chips in drafts", async () => {
    const { service, onStart } = testService();
    unregister = registerMentionService(FILE, service);
    // An empty document: the widget's keeper self-inserts an aiPrompt
    // (with its draft) on create.
    editor = await documentEditor("");
    let blobId: string | null = null;
    editor.state.doc.descendants((node) => {
      if (blobId === null && node.type.name === "aiPrompt") {
        blobId = node.attrs.blobId as string;
      }
      return blobId === null;
    });
    expect(blobId).not.toBeNull();
    const range = promptDraftRange(editor.state.doc, blobId!);
    expect(range).not.toBeNull();
    await typeAt(editor, "@", range!.from);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Exactly one of the two suggestions started — the widget's — and its
    // pick inserts a mention chip, not a link.
    expect(onStart).toHaveBeenCalledTimes(1);
    const props = onStart.mock.calls[0][0];
    props.command(ROWS[0]);
    // The pick landed as a mention chip inside the draft, not a link.
    let mentionInDraft = false;
    let anyLink = false;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mention") mentionInDraft = true;
      if (node.marks.some((mark) => mark.type.name === "link")) anyLink = true;
      return true;
    });
    expect(mentionInDraft).toBe(true);
    expect(anyLink).toBe(false);
  });
});

describe("pageLinkHref", () => {
  it("is file-relative for targets under the file's directory", () => {
    expect(pageLinkHref("/ws/docs/page.md", "/ws", "docs/other.md")).toBe(
      "other.md",
    );
    expect(pageLinkHref("/ws/docs/page.md", "/ws", "docs/sub/deep.md")).toBe(
      "sub/deep.md",
    );
  });

  it("falls back to the workspace-relative path for upward targets", () => {
    expect(pageLinkHref("/ws/docs/page.md", "/ws", "notes.md")).toBe(
      "notes.md",
    );
    expect(pageLinkHref("/ws/docs/page.md", "/ws", "assets/a.png")).toBe(
      "assets/a.png",
    );
  });
});

describe("pageLinkLabel", () => {
  it("drops a page's .md extension, keeps other names whole", () => {
    expect(pageLinkLabel("notes.md")).toBe("notes");
    expect(pageLinkLabel("photo.png")).toBe("photo.png");
    expect(pageLinkLabel(".md")).toBe(".md");
  });
});
