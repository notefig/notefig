import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FileTree } from "@pierre/trees";
import { attachTreeStatHydration } from "../tree-stat-hydration";
import { hydrateDirectoryStats } from "@/entities/files";

vi.mock("@/entities/files", () => ({
  hydrateDirectoryStats: vi.fn(() => Promise.resolve()),
}));

const hydrateMock = vi.mocked(hydrateDirectoryStats);

const WS = "/ws";
const toAbs = (rel: string) => `${WS}/${rel.replace(/\/+$/, "")}`;

let model: FileTree;
let detach: (() => void) | null = null;

function attach(): void {
  detach = attachTreeStatHydration(model, WS, toAbs);
}

beforeEach(() => {
  hydrateMock.mockClear();
  hydrateMock.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  detach?.();
  detach = null;
  model?.cleanUp();
});

describe("attachTreeStatHydration", () => {
  it("hydrates the workspace root on attach", () => {
    model = new FileTree({ paths: ["a.md"], initialExpansion: "closed" });
    attach();
    expect(hydrateMock).toHaveBeenCalledWith(WS, WS);
  });

  it("hydrates expanded directories but not collapsed ones", () => {
    model = new FileTree({
      paths: ["open/inner.md", "closed/inner.md"],
      initialExpandedPaths: ["open"],
    });
    attach();
    expect(hydrateMock).toHaveBeenCalledWith(WS, `${WS}/open`);
    expect(hydrateMock).not.toHaveBeenCalledWith(WS, `${WS}/closed`);
  });

  it("hydrates a directory once it expands", () => {
    model = new FileTree({
      paths: ["docs/inner.md"],
      initialExpansion: "closed",
    });
    attach();
    expect(hydrateMock).not.toHaveBeenCalledWith(WS, `${WS}/docs`);

    const dir = model.getItem("docs");
    if (dir && "expand" in dir) dir.expand();

    expect(hydrateMock).toHaveBeenCalledWith(WS, `${WS}/docs`);
  });

  it("re-hydrates when a row arrives, not on count-neutral notifications", () => {
    model = new FileTree({
      paths: ["docs/inner.md"],
      initialExpandedPaths: ["docs"],
    });
    attach();
    const callsAfterAttach = hydrateMock.mock.calls.length;

    // Count-neutral: focus moves notify subscribers without changing rows.
    model.focusFirstItem();
    model.focusNextItem();
    expect(hydrateMock.mock.calls.length).toBe(callsAfterAttach);

    // A row arrived after the initial listing.
    model.add("docs/late.md");
    expect(hydrateMock.mock.calls.length).toBeGreaterThan(callsAfterAttach);
    expect(hydrateMock).toHaveBeenCalledWith(WS, `${WS}/docs`);
  });

  it("stops hydrating after detach", () => {
    model = new FileTree({ paths: ["a.md"], initialExpansion: "closed" });
    attach();
    const calls = hydrateMock.mock.calls.length;

    detach?.();
    detach = null;
    model.add("late.md");

    expect(hydrateMock.mock.calls.length).toBe(calls);
  });

  it("swallows hydration failures instead of surfacing an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    hydrateMock.mockImplementationOnce(() =>
      Promise.reject(new Error("stat failed")),
    );

    model = new FileTree({ paths: ["a.md"], initialExpansion: "closed" });
    attach();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    warn.mockRestore();
  });
});
