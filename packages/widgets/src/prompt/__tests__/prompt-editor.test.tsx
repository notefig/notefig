/**
 * The composer: a real Tiptap instance driving the "@" mention suggestion,
 * and the pure token extraction behind it.
 *
 * The workspace's files arrive through the host — a fixed list here, ranked
 * by the app in production. That is the whole reason this file no longer
 * needs the platform adapter, the file collections, or a test database:
 * everything it once mocked was the app reaching into the composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MentionCandidate } from "../host";
import {
  PromptEditor,
  extractMentionPaths,
  type PromptEditorHandle,
} from "../composer/prompt-editor";
import { fakePromptWidgetHost, withHost } from "../../testing/fake-host";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty" as const, init: () => {} },
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
const FILES = ["notes.md", "readme.md", "archive/old.md", "my spaced file.md"];

/** The host's two file questions, over a fixed list. Ranking and openability
 *  filtering are the app's; a substring match is all these cases need. */
const host = fakePromptWidgetHost({
  isWorkspaceFile: (_workspacePath, token) => FILES.includes(token),
  searchWorkspaceFiles: (_workspacePath, query, limit): MentionCandidate[] =>
    FILES.filter((relativePath) =>
      relativePath.toLowerCase().includes(query.toLowerCase()),
    )
      .slice(0, limit)
      .map((relativePath) => ({
        relativePath,
        title: relativePath.slice(relativePath.lastIndexOf("/") + 1),
        path: `${WS}/${relativePath}`,
      })),
});

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

let latestHandle: PromptEditorHandle | null = null;

function Harness({ workspacePath }: { workspacePath: string }) {
  const [value, setValue] = useState("");
  const editorRef = useRef<PromptEditorHandle>(null);
  latestValue = value;
  setHostValue = setValue;
  latestHandle = editorRef.current;
  return createElement(PromptEditor, {
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
  hostKeyDown.mockClear();
  lastKeyDownConsumed = null;

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(withHost(host, createElement(Harness, { workspacePath: WS })));
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
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

  it("a stale handle no-ops after the editor is destroyed (crash 2026-08-21)", async () => {
    await setDraft("warm up");
    // Re-render to observe the populated ref, then unmount — the dock does
    // this to unselected tabs; a parent effect can still hold the handle.
    await act(async () => {
      setHostValue("warm up again");
    });
    const handle = latestHandle;
    expect(handle).not.toBeNull();
    act(() => root?.unmount());
    root = null;
    expect(() => handle!.focus()).not.toThrow();
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

describe("extractMentionPaths", () => {
  const workspace = (...paths: string[]) => {
    const set = new Set(paths);
    return (candidate: string) => set.has(candidate);
  };
  const extract = (text: string, isPath: (c: string) => boolean) =>
    extractMentionPaths(text, isPath);

  it("extracts mentions at start, mid-text, and after newlines; dedupes; ignores mid-word @", () => {
    const isPath = workspace("a.md", "docs/b.md", "c.md");
    expect(
      extract("@a.md check with @docs/b.md\n@c.md a@a.md @a.md", isPath),
    ).toEqual(["a.md", "docs/b.md", "c.md"]);
  });

  it("resolves paths containing spaces, and strips trailing punctuation", () => {
    const isPath = workspace("my file.md", "my", "notes.md");
    expect(extract("read @my file.md before lunch", isPath)).toEqual([
      "my file.md",
    ]);
    expect(extract("(see @notes.md!)", isPath)).toEqual(["notes.md"]);
  });

  it("never extends a mention into following prose (greptile #3)", () => {
    // Both names exist; the longer one would only win by swallowing prose.
    const isPath = workspace("my file.md", "my file.md is");
    expect(extract("read @my file.md is fine", isPath)).toEqual(["my file.md"]);
  });

  it("allows multi-word extensionless paths only at line end", () => {
    const isPath = workspace("my notes");
    expect(extract("summarize @my notes", isPath)).toEqual(["my notes"]);
    expect(extract("summarize @my notes please", isPath)).toEqual([]);
  });

  it("resolves paths with many space-separated words (greptile #2)", () => {
    const long = "a b c d e f g h i j.md";
    expect(extract(`see @${long}`, workspace(long))).toEqual([long]);
  });

  it("stays within its line and returns [] with no matches", () => {
    expect(extract("@my\nfile.md", workspace("my file.md"))).toEqual([]);
    expect(extract("no mentions", () => true)).toEqual([]);
    expect(extract("@ alone", () => true)).toEqual([]);
  });
});
