import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

// Real TanStack DB collections, mocked fs seam — file results come from the
// actual metadata collection through useFileSearch.
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
let CommandPalette: typeof import("../command-palette").CommandPalette;
let ThemeProvider: typeof import("../../theme-provider").ThemeProvider;
let WorkspaceTabsProvider: typeof import("../../workspace-tabs-provider").WorkspaceTabsProvider;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const openFile = vi.fn().mockReturnValue(true);

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
          children: createElement(WorkspaceTabsProvider, {
            openFile,
            children: createElement(CommandPalette, {
              open: true,
              sidebarOpen: false,
              workspacePath: WS,
              onOpenChange: vi.fn(),
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
  WS = `/ws-palette-${testCounter++}`;
  adapter.getMetadata.mockResolvedValue({ succeeded: [], failed: [] });
  adapter.readDirectory.mockImplementation(
    async (_dir: string, options: { includeFiles: boolean }) => ({
      ok: true,
      value: options.includeFiles
        ? [
            `${WS}/notes.md`,
            `${WS}/archive/old-notes.md`,
            `${WS}/theme.md`,
            `${WS}/binary.bin`,
          ]
        : [`${WS}/archive`],
    }),
  );

  files = await import("@/entities/files");
  ({ CommandPalette } = await import("../command-palette"));
  ({ ThemeProvider } = await import("../../theme-provider"));
  ({ WorkspaceTabsProvider } = await import("../../workspace-tabs-provider"));
  await files.getOrCreateWorkspaceCollections(WS).metadata.preload();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  files.clearWorkspaceCollections(WS);
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
    expect(labels).toContain("archive/old-notes.md");
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
    expect(openFile).toHaveBeenCalledWith({
      tabId: `${WS}/notes.md`,
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
