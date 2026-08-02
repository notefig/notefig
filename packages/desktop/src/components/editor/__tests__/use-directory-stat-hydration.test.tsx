import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDirectoryStatHydration } from "../use-directory-stat-hydration";
import { hydrateDirectoryStats } from "@/entities/files";

vi.mock("@/entities/files", () => ({
  hydrateDirectoryStats: vi.fn(() => Promise.resolve()),
}));

const hydrateMock = vi.mocked(hydrateDirectoryStats);

const WS = "/ws";
const DIR = "/ws/docs";

interface HarnessProps {
  children?: unknown[];
  isExpanded?: boolean;
  type?: "file" | "directory";
  path?: string;
}

function Harness({
  children = [],
  isExpanded = true,
  type = "directory",
  path = DIR,
}: HarnessProps) {
  useDirectoryStatHydration(WS, { path, type, children }, isExpanded);
  return null;
}

let root: Root;

async function render(props: HarnessProps): Promise<void> {
  await act(async () => {
    root.render(createElement(Harness, props));
  });
}

beforeEach(() => {
  hydrateMock.mockClear();
  hydrateMock.mockImplementation(() => Promise.resolve());
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
});

describe("useDirectoryStatHydration", () => {
  it("hydrates an expanded directory", async () => {
    await render({});
    expect(hydrateMock).toHaveBeenCalledWith(WS, DIR);
  });

  it("does nothing while the directory is collapsed", async () => {
    await render({ isExpanded: false });
    expect(hydrateMock).not.toHaveBeenCalled();
  });

  it("does nothing for a file node", async () => {
    await render({ type: "file", path: "/ws/a.md" });
    expect(hydrateMock).not.toHaveBeenCalled();
  });

  it("re-hydrates on child-count change, not on unrelated re-renders", async () => {
    await render({ children: [1] });
    expect(hydrateMock).toHaveBeenCalledTimes(1);

    // Same count, fresh node object — must not re-trigger.
    await render({ children: [2] });
    expect(hydrateMock).toHaveBeenCalledTimes(1);

    // A row arrived after the initial listing.
    await render({ children: [1, 2] });
    expect(hydrateMock).toHaveBeenCalledTimes(2);
  });

  it("hydrates once a collapsed directory expands", async () => {
    await render({ isExpanded: false });
    expect(hydrateMock).not.toHaveBeenCalled();

    await render({ isExpanded: true });
    expect(hydrateMock).toHaveBeenCalledTimes(1);
  });

  it("swallows hydration failures instead of surfacing an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    hydrateMock.mockImplementationOnce(() =>
      Promise.reject(new Error("stat failed")),
    );

    await render({});
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    warn.mockRestore();
  });
});
