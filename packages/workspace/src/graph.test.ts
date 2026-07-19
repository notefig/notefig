/**
 * Tests the actual point of this package: given any one entity, you can
 * reach the related ones through consistent handles, in either direction.
 */
import { registerEditorProvider } from "./editors";
import { registerFileProvider } from "./files";
import { registerTabSource, tab } from "./tabs";
import { file } from "./files";
import { blob } from "./blobs";
import { registerGitStatusProvider, type FileGitState } from "./git-status";
import type { RepoStatus } from "@metrists/git";

const WORKSPACE = "/ws";
const FILE_PATH = "/ws/notes.md";
const AGENT_TAB_ID = "agent:task_123";

const MARKDOWN = [
  "# Doc",
  "",
  "```metrists:question",
  "id: q_test1",
  "status: pending",
  "prompt: Which tier?",
  "```",
  "",
  "After.",
].join("\n");

registerEditorProvider(() => undefined); // no mounted editor — force fallback to file content

registerFileProvider((workspacePath, filePath) => {
  if (workspacePath === WORKSPACE && filePath === FILE_PATH) {
    return { content: MARKDOWN, exists: true };
  }
  return undefined;
});

registerTabSource(() => [FILE_PATH, AGENT_TAB_ID]);

describe("tab -> file -> blob -> file round trip", () => {
  it("TabHandle.file() resolves the underlying FileHandle", () => {
    const t = tab(WORKSPACE, FILE_PATH);
    expect(t.isOpen()).toBe(true);
    expect(t.file()?.filePath).toBe(FILE_PATH);
    expect(t.file()?.content()).toBe(MARKDOWN);
  });

  it("TabHandle.blobs() parses the file's fenced blobs", () => {
    const blobs = tab(WORKSPACE, FILE_PATH).blobs();
    expect(blobs).toHaveLength(1);
    expect(blobs[0].blobId).toBe("q_test1");
    expect(blobs[0].envelope()?.id).toBe("q_test1");
  });

  it("FileHandle.blobs() agrees with TabHandle.blobs()", () => {
    expect(file(WORKSPACE, FILE_PATH).blobs().map((b) => b.blobId)).toEqual(["q_test1"]);
  });

  it("FileHandle.tabs() reverse-links back to the originating tab", () => {
    const tabs = file(WORKSPACE, FILE_PATH).tabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].tabId).toBe(FILE_PATH);
  });

  it("BlobHandle.file() reverse-links back to the file, closing the loop", () => {
    const b = blob(WORKSPACE, FILE_PATH, "q_test1");
    const f = b.file();
    expect(f.filePath).toBe(FILE_PATH);
    // and back through the file to the same tab we started from
    expect(f.tabs()[0]?.tabId).toBe(FILE_PATH);
  });
});

describe("agent tabs short-circuit the file-shaped chain", () => {
  it("has no editor, file, or blobs", () => {
    const t = tab(WORKSPACE, AGENT_TAB_ID);
    expect(t.isAgentTab()).toBe(true);
    expect(t.isOpen()).toBe(true);
    expect(t.editor()).toBeUndefined();
    expect(t.file()).toBeUndefined();
    expect(t.blobs()).toEqual([]);
  });
});

describe("git status derivation", () => {
  const status: RepoStatus = {
    repoPath: WORKSPACE,
    currentBranch: "main",
    staged: [],
    unstaged: [{ path: "notes.md", type: "modified" }],
    untracked: [],
    conflicts: [],
  };

  beforeEach(() => {
    registerGitStatusProvider(() => status);
  });

  it("derives per-file state from the already-fetched whole-repo status", () => {
    const state: FileGitState | undefined = file(WORKSPACE, FILE_PATH).git().state();
    expect(state).toEqual({ kind: "unstaged", changeType: "modified" });
  });

  it("returns clean for a path not present in any status array", () => {
    const state = file(WORKSPACE, "/ws/other.md").git().state();
    expect(state).toEqual({ kind: "clean" });
  });
});
