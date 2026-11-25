import { describe, it, expect, afterEach } from "vitest";
import {
  createWorkspaceTreeModel,
  resetTree,
  type TreeModelEntry,
  type TreeSortState,
} from "./tree-model";
import {
  APP_DIR_NAME,
  SCRATCHPADS_REL_PATH,
} from "@/modules/scratchpads";

let entry: TreeModelEntry | null = null;
let workspaceCounter = 0;

afterEach(() => {
  entry?.model.cleanUp();
  entry = null;
});

function modelEntry(
  order: "name-asc" | "name-desc" | "date-modified",
): { model: TreeModelEntry["model"]; sortState: TreeSortState } {
  const workspacePath = `/ws-${(workspaceCounter += 1)}`;
  entry = createWorkspaceTreeModel(workspacePath).acquire({
    order,
    itemHeightPx: 28,
    initialSelectedPaths: [],
    initialExpandedPaths: [APP_DIR_NAME, SCRATCHPADS_REL_PATH],
    delegate: {
      containsOpenTab: () => false,
      moveFile: () => {},
      renameFile: () => {},
      createEntry: () => {},
    },
  });
  return { model: entry.model, sortState: entry.sortState };
}

function visiblePaths(model: TreeModelEntry["model"]): string[] {
  const count = model.getVisibleCount();
  return model.getVisibleRows(0, count).map((row) => row.path);
}

describe("tree model scratchpad pinning", () => {
  it("keeps the scratchpads root above regular files in name-asc order", () => {
    const { model } = modelEntry("name-asc");
    model.resetPaths([
      `${SCRATCHPADS_REL_PATH}/`,
      `${SCRATCHPADS_REL_PATH}/zebra.md`,
      `${SCRATCHPADS_REL_PATH}/alpha.md`,
      "apple.md",
      "zebra.md",
    ]);
    expect(visiblePaths(model)).toEqual([
      `${SCRATCHPADS_REL_PATH}/`,
      `${SCRATCHPADS_REL_PATH}/alpha.md`,
      `${SCRATCHPADS_REL_PATH}/zebra.md`,
      "apple.md",
      "zebra.md",
    ]);
  });

  it("keeps the scratchpads root above regular files in name-desc order", () => {
    const { model } = modelEntry("name-desc");
    model.resetPaths([
      `${SCRATCHPADS_REL_PATH}/`,
      `${SCRATCHPADS_REL_PATH}/zebra.md`,
      `${SCRATCHPADS_REL_PATH}/alpha.md`,
      "apple.md",
      "zebra.md",
    ]);
    expect(visiblePaths(model)).toEqual([
      `${SCRATCHPADS_REL_PATH}/`,
      `${SCRATCHPADS_REL_PATH}/zebra.md`,
      `${SCRATCHPADS_REL_PATH}/alpha.md`,
      "zebra.md",
      "apple.md",
    ]);
  });

  it("keeps the scratchpads root above regular files in date-modified order", () => {
    const { model, sortState } = modelEntry("date-modified");
    sortState.modifiedByRelPath = new Map([
      ["apple.md", 1000],
      ["zebra.md", 2000],
      [SCRATCHPADS_REL_PATH, 500],
      [`${SCRATCHPADS_REL_PATH}/alpha.md`, 3000],
      [`${SCRATCHPADS_REL_PATH}/zebra.md`, 4000],
    ]);
    model.resetPaths([
      `${SCRATCHPADS_REL_PATH}/`,
      `${SCRATCHPADS_REL_PATH}/zebra.md`,
      `${SCRATCHPADS_REL_PATH}/alpha.md`,
      "apple.md",
      "zebra.md",
    ]);
    expect(visiblePaths(model)).toEqual([
      `${SCRATCHPADS_REL_PATH}/`,
      `${SCRATCHPADS_REL_PATH}/zebra.md`,
      `${SCRATCHPADS_REL_PATH}/alpha.md`,
      "zebra.md",
      "apple.md",
    ]);
  });

  it("still orders regular root items according to the sort state", () => {
    const { model } = modelEntry("name-desc");
    model.resetPaths([
      `${SCRATCHPADS_REL_PATH}/`,
      "docs/",
      "apple.md",
      "zebra.md",
    ]);
    const roots = visiblePaths(model).filter(
      (path) => path !== `${SCRATCHPADS_REL_PATH}/`,
    );
    expect(roots).toEqual(["zebra.md", "docs/", "apple.md"]);
  });
});

describe("resetTree", () => {
  it("keeps a directory open under date-modified order once a newer sibling with a later name sorts above it", () => {
    const { model, sortState } = modelEntry("date-modified");
    const paths = ["docs/", "docs/inner.md", "notes.md"];
    // A prompt sent from notes.md saved it: it's now newer than docs.
    sortState.modifiedByRelPath = new Map([
      ["docs", 1],
      ["docs/inner.md", 1],
      ["notes.md", 2],
    ]);
    resetTree(model, paths, ["docs"]);
    expect(visiblePaths(model)).toEqual(["notes.md", "docs/", "docs/inner.md"]);
  });
});
