import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "@/utils/intl";

// Real TanStack DB collections, mocked fs seam (same harness as
// use-file-search.test.tsx) — the mention suggestion lists rows from the
// actual metadata collection, and the editor is a real Tiptap instance.
const adapter = {
  createFiles: vi.fn(),
  writeFiles: vi.fn(),
  deleteFiles: vi.fn(),
  getMetadata: vi.fn(),
  readFiles: vi.fn(),
  readDirectory: vi.fn(),
};

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    fs: adapter,
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

vi.mock("@/utils/file-write-effects", () => ({
  invalidateDerivedState: vi.fn(),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let testCounter = 0;
let WS = "";

let files: typeof import("@/entities/files");
let promptEditor: typeof import("../prompt-editor");
let mentionContext: typeof import("@/agent/prompt-mention-context");

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latestValue = "";
let setHostValue: (value: string) => void = () => {};
let lastKeyDownConsumed: boolean | null = null;
const hostKeyDown = vi.fn((event: KeyboardEvent) => {
  // The chat composer's contract: Enter submits when the popup is closed.
  if (event.key === "Enter" && !event.shiftKey) return true;
  return false;
});

function Host({ workspacePath }: { workspacePath: string }) {
  const [value, setValue] = useState("");
  const editorRef = useRef<import("../prompt-editor").PromptEditorHandle>(null);
  latestValue = value;
  setHostValue = setValue;
  return createElement(promptEditor.PromptEditor, {
    ref: editorRef,
    workspacePath,
    value,
    onChange: setValue,
    onKeyDown: (event: KeyboardEvent) => {
      lastKeyDownConsumed = hostKeyDown(event);
      return lastKeyDownConsumed;
    },
    placeholder: "Prompt...",
    autoFocus: true,
  });
}

function proseMirror(): HTMLElement {
  return document.querySelector(".ProseMirror") as HTMLElement;
}

function options(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map(
    (el) => el.textContent ?? "",
  );
}

async function setDraft(text: string) {
  await act(async () => {
    setHostValue(text);
  });
  // The value-sync effect focuses the editor at the end, which is what
  // arms the suggestion match at the caret.
  await act(async () => {});
}

async function pressKey(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    proseMirror().dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  lastKeyDownConsumed = null;
  WS = `/ws-prompt-editor-${testCounter++}`;
  adapter.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter.readDirectory.mockImplementation(
    async (_dir: string, opts: { includeFiles: boolean }) => ({
      ok: true,
      value: opts.includeFiles
        ? [
            `${WS}/notes.md`,
            `${WS}/readme.md`,
            `${WS}/archive/old.md`,
            `${WS}/my spaced file.md`,
          ]
        : [`${WS}/archive`],
    }),
  );

  files = await import("@/entities/files");
  promptEditor = await import("../prompt-editor");
  mentionContext = await import("@/agent/prompt-mention-context");
  await files.getOrCreateWorkspaceCollections(WS).metadata.preload();

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Host, { workspacePath: WS }));
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  files.clearWorkspaceCollections(WS);
  document.body.innerHTML = "";
});

describe("PromptEditor mention suggestion", () => {
  it("opens on a bare @ listing files, filters as the query grows", async () => {
    expect(options()).toEqual([]);
    await setDraft("see @");
    expect(options().join("\n")).toContain("notes.md");
    expect(options().join("\n")).toContain("readme.md");

    await setDraft("see @no");
    const filtered = options().join("\n");
    expect(filtered).toContain("notes.md");
    expect(filtered).not.toContain("readme.md");
  });

  it("Enter picks the selected file, inserting a chip that serializes to @relativePath", async () => {
    await setDraft("see @no");
    expect(options().length).toBeGreaterThan(0);
    await pressKey("Enter");
    expect(latestValue).toBe("see @notes.md ");
    expect(options()).toEqual([]);
    // The chip renders as an atomic mention node showing the basename.
    const chip = proseMirror().querySelector('[data-type="mention"]');
    expect(chip?.getAttribute("data-id")).toBe("notes.md");
    // Host Enter (submit) was never consulted while the popup was open.
    expect(hostKeyDown).not.toHaveBeenCalled();
  });

  it("arrow keys move the selection before picking", async () => {
    await setDraft("@");
    expect(options().length).toBeGreaterThan(1);
    await pressKey("ArrowDown");
    await pressKey("Enter");
    expect(latestValue.startsWith("@")).toBe(true);
    expect(latestValue.trim().length).toBeGreaterThan(1);
  });

  it("host onKeyDown owns Enter when the popup is closed", async () => {
    await setDraft("plain text");
    await pressKey("Enter");
    expect(hostKeyDown).toHaveBeenCalled();
    expect(lastKeyDownConsumed).toBe(true);
    // Consumed Enter never split the paragraph.
    expect(latestValue).toBe("plain text");
  });

  it("revives chips from a persisted draft string", async () => {
    await setDraft("read @notes.md now");
    const chip = proseMirror().querySelector('[data-type="mention"]');
    expect(chip?.getAttribute("data-id")).toBe("notes.md");
    expect(chip?.textContent).toBe("@notes.md");
    // Round-trip: serialization reproduces the draft exactly.
    expect(latestValue).toBe("read @notes.md now");
  });
});

describe("mentionContextParts", () => {
  it("turns tokens naming real files into file:// resource_link parts", () => {
    const parts = mentionContext.mentionContextParts(
      WS,
      "read @notes.md and @missing.md, also @archive/old.md.",
    );
    expect(parts).toEqual([
      {
        kind: "resource_link",
        path: `file://${WS}/notes.md`,
        name: "notes.md",
      },
      {
        kind: "resource_link",
        path: `file://${WS}/archive/old.md`,
        name: "archive/old.md",
      },
    ]);
  });

  it("skips directories and text without mentions", () => {
    expect(mentionContext.mentionContextParts(WS, "see @archive")).toEqual([]);
    expect(mentionContext.mentionContextParts(WS, "no refs")).toEqual([]);
  });

  it("resolves picker-inserted mentions whose paths contain spaces", () => {
    const parts = mentionContext.mentionContextParts(
      WS,
      "summarize @my spaced file.md please",
    );
    expect(parts).toEqual([
      {
        kind: "resource_link",
        path: `file://${WS}/my%20spaced%20file.md`,
        name: "my spaced file.md",
      },
    ]);
  });
});
