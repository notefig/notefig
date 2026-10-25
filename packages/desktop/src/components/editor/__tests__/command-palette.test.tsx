import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { defineModule, type Core } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import { CommandPalette } from "../command-palette";
import { ThemeProvider } from "../../theme-provider";
import { createTestCore } from "@/testing/test-core";
import { filesModuleOf, testWorkspaceFiles } from "@/testing/test-files";
import type { WorkspaceFiles } from "@/modules/files";
import { kvModule } from "@/modules/kv";
import { createFeedback, type FeedbackApi } from "@/modules/feedback";
import { workspacesModule } from "@/modules/workspaces";
import { path as pathutil } from "@/utils/path";

// Real TanStack DB collections over a listing handed to them — file
// results come from the actual metadata collection through useFileSearch.
const adapter = {
  getMetadata: vi.fn(),
  readDirectory: vi.fn(),
};

const adapter2 = {
  getMetadata: vi.fn(),
  readDirectory: vi.fn(),
};

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws-palette";
const WS2 = "/ws-palette-2";

let files: WorkspaceFiles;
let files2: WorkspaceFiles;
let testCore: Core;
let feedback: FeedbackApi;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const openFile = vi.fn().mockReturnValue(true);
const openUsageSettings = vi.fn();

function renderPalette() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        MemoryRouter,
        null,
        createElement(ThemeProvider, {
          defaultTheme: "light",
          children: createElement(CoreProvider, {
            // A real test core, with tab opens recorded instead of applied.
            core: { ...testCore, tabs: { open: openFile } } as never,
            children: createElement(CommandPalette, {
              open: true,
              workspacePath: WS,
              onOpenChange: vi.fn(),
              onOpenUsageSettings: openUsageSettings,
            }),
          }),
        }),
      ),
    );
  });
}

// The palette's CommandInput is a controlled React input — updates must go
// through the native value setter so React sees the change event.
async function typeQuery(text: string) {
  const input = document.querySelector("[cmdk-input]") as HTMLInputElement;
  expect(input).toBeTruthy();
  const setValue = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value",
  )?.set;
  await act(async () => {
    if (setValue) setValue.call(input, text);
    else input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function itemLabels(): string[] {
  return [...document.querySelectorAll("[cmdk-item]")].map(
    (el) => el.textContent ?? "",
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  openFile.mockReturnValue(true);
  adapter.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter.readDirectory.mockImplementation(async () => ({
    ok: true,
    value: [
      { path: `${WS}/archive`, type: "directory" as const },
      { path: `${WS}/notes.md`, type: "file" as const },
      { path: `${WS}/archive/old-notes.md`, type: "file" as const },
      { path: `${WS}/theme.md`, type: "file" as const },
      { path: `${WS}/binary.bin`, type: "file" as const },
    ],
  }));
  adapter2.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter2.readDirectory.mockImplementation(async () => ({
    ok: true,
    value: [
      { path: `${WS2}/shared.md`, type: "file" as const },
      { path: `${WS2}/project/other.md`, type: "file" as const },
    ],
  }));

  files = testWorkspaceFiles(WS, adapter);
  files2 = testWorkspaceFiles(WS2, adapter2);
  // The settings the palette reads persist through the kv store over the
  // test core's platform db.
  feedback = createFeedback({ supportUrl: "https://support.notefig.com" });
  testCore = createTestCore({
    modules: [
      kvModule,
      filesModuleOf([files, files2]),
      workspacesModule,
      defineModule({ name: "feedback", register: () => feedback }),
    ],
  });
  testCore.boot();
  await testCore.workspace(WS).open();
  await files.collections.metadata.preload();
});

afterEach(async () => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  await testCore.dispose();
  files.dispose();
  files2.dispose();
  document.body.innerHTML = "";
});

describe("CommandPalette file search", () => {
  it("shows no file group for an empty query, then files for a filename query", async () => {
    renderPalette();
    await act(async () => {});
    expect(itemLabels().join("\n")).not.toContain("notes.md");

    await typeQuery("notes");
    const labels = itemLabels().join("\n");
    expect(labels).toContain("notes.md");
    // A nested file shows its parent folder after the name.
    expect(labels).toContain("old-notes.mdarchive");
    // binary.bin is refused by the canOpenFile filter and never listed.
    await typeQuery("binary");
    expect(itemLabels().join("\n")).not.toContain("binary.bin");
  });

  it("opens the selected file as a replace tab", async () => {
    renderPalette();
    await act(async () => {});
    await typeQuery("notes");
    const item = [...document.querySelectorAll("[cmdk-item]")].find((el) =>
      (el.textContent ?? "").includes("notes.md"),
    ) as HTMLElement;
    expect(item).toBeTruthy();
    await act(async () => {
      item.click();
    });
    expect(openFile).toHaveBeenCalledWith(`${WS}/notes.md`, {
      intent: "replace",
    });
  });

  it("still filters commands by label and keywords (cmdk default filter)", async () => {
    renderPalette();
    await act(async () => {});
    // Empty query: all commands visible, e.g. the file group's "New file".
    expect(itemLabels().join("\n")).toContain("New file");

    // "create" is only a keyword of New file/New folder, not a label.
    await typeQuery("create");
    const labels = itemLabels().join("\n");
    expect(labels).toContain("New file");
    expect(labels).not.toContain("Toggle Theme");
  });

  it("lists matching commands above file results (Linear-style quick results)", async () => {
    renderPalette();
    await act(async () => {});
    await typeQuery("theme");
    const labels = itemLabels();
    const commandIndex = labels.findIndex((l) => l.includes("Toggle Theme"));
    const fileIndex = labels.findIndex((l) => l.includes("theme.md"));
    expect(commandIndex).toBeGreaterThanOrEqual(0);
    expect(fileIndex).toBeGreaterThan(commandIndex);
  });
});

describe("CommandPalette file search across open workspaces", () => {
  beforeEach(async () => {
    await testCore.workspace(WS2).open();
    await files2.collections.metadata.preload();
  });

  it("shows files from the active workspace and other open workspaces", async () => {
    renderPalette();
    await act(async () => {});
    await typeQuery("other");
    const row = document.querySelector(
      `[cmdk-item][data-value="file-result:${WS2}/project/other.md"]`,
    );
    // Title, parent folder, then the workspace it lives in.
    expect(row?.textContent).toBe(`other.mdproject${pathutil.basename(WS2)}`);
  });

  it("names no workspace while every result is from the active one", async () => {
    renderPalette();
    await act(async () => {});
    await typeQuery("notes");
    expect(itemLabels().join("\n")).not.toContain(pathutil.basename(WS2));
  });
});

describe("CommandPalette file search updates with the input", () => {
  it("lists files on the same keystroke as the commands", async () => {
    renderPalette();
    await act(async () => {});
    await typeQuery("notes");
    expect(itemLabels().join("\n")).toContain("notes.md");
  });

  it("drops file results on the keystroke that stops matching", async () => {
    renderPalette();
    await act(async () => {});
    await typeQuery("notes");
    await typeQuery("notesx");
    expect(itemLabels().join("\n")).not.toContain("notes.md");
    await typeQuery("");
    expect(itemLabels().join("\n")).not.toContain("notes.md");
  });
});

describe("CommandPalette help commands", () => {
  it("opens the feedback dialog from Send Feedback", async () => {
    renderPalette();
    await act(async () => {});
    await typeQuery("feedback");
    const item = [...document.querySelectorAll("[cmdk-item]")].find((el) =>
      (el.textContent ?? "").includes("Send Feedback"),
    ) as HTMLElement;
    await act(async () => {
      item.click();
    });
    expect(feedback.isOpen()).toBe(true);
  });
});

describe("CommandPalette settings commands", () => {
  it("opens usage settings from the Open Usage command", async () => {
    renderPalette();
    await act(async () => {});
    await typeQuery("usage");
    const item = [...document.querySelectorAll("[cmdk-item]")].find((el) =>
      (el.textContent ?? "").includes("Open Usage"),
    ) as HTMLElement;
    expect(item).toBeTruthy();
    await act(async () => {
      item.click();
    });
    expect(openUsageSettings).toHaveBeenCalled();
  });
});
