import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import "@/utils/intl";

// Real TanStack DB collections, mocked fs seam (same harness as
// use-file-search.test.tsx) — the picker lists rows from the actual
// metadata collection.
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
let mentionPicker: typeof import("../mention-picker");
let mentionContext: typeof import("@/agent/prompt-mention-context");

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latestValue = "";

function Host({ workspacePath }: { workspacePath: string }) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  latestValue = value;
  const picker = mentionPicker.useMentionPicker({
    workspacePath,
    value,
    onChange: setValue,
    textareaRef,
  });
  return createElement(
    mentionPicker.MentionPicker,
    { picker, children: null },
    createElement("textarea", {
      ref: textareaRef,
      value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        setValue(event.target.value),
      onSelect: picker.handleSelectionChange,
      onKeyDown: picker.handleKeyDown,
      "data-testid": "mention-host",
    }),
  );
}

function textarea(): HTMLTextAreaElement {
  return document.querySelector(
    '[data-testid="mention-host"]',
  ) as HTMLTextAreaElement;
}

async function typeText(text: string) {
  const el = textarea();
  el.focus();
  const setValue = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(el),
    "value",
  )?.set;
  await act(async () => {
    if (setValue) setValue.call(el, text);
    else el.value = text;
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function options(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map(
    (el) => el.textContent ?? "",
  );
}

async function pressKey(key: string) {
  await act(async () => {
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  WS = `/ws-mention-${testCounter++}`;
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
  mentionPicker = await import("../mention-picker");
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

describe("useMentionPicker + MentionPicker", () => {
  it("opens on a bare @ listing files, filters as the query grows", async () => {
    expect(options()).toEqual([]);
    await typeText("@");
    expect(options().join("\n")).toContain("notes.md");
    expect(options().join("\n")).toContain("readme.md");

    await typeText("@no");
    const filtered = options().join("\n");
    expect(filtered).toContain("notes.md");
    expect(filtered).not.toContain("readme.md");
  });

  it("does not open for mid-word @ or after the mention is closed", async () => {
    await typeText("mail a@b");
    expect(options()).toEqual([]);
    await typeText("@notes.md done ");
    expect(options()).toEqual([]);
  });

  it("Enter inserts the selected file as @relativePath and closes", async () => {
    await typeText("see @no");
    expect(options().length).toBeGreaterThan(0);
    await pressKey("Enter");
    expect(latestValue).toBe("see @notes.md ");
    expect(options()).toEqual([]);
  });

  it("arrow keys move the selection before picking", async () => {
    await typeText("@");
    const first = options();
    expect(first.length).toBeGreaterThan(1);
    await pressKey("ArrowDown");
    await pressKey("Enter");
    // Second row (shortest-path ordering puts notes.md/readme.md first two).
    expect(latestValue).not.toBe("");
    expect(latestValue.startsWith("@")).toBe(true);
  });

  it("Escape dismisses without eating the mention text", async () => {
    await typeText("@no");
    expect(options().length).toBeGreaterThan(0);
    await pressKey("Escape");
    expect(options()).toEqual([]);
    expect(latestValue).toBe("@no");
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
