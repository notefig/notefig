import { GitError } from "./types";
import { StubGitService } from "./stubService";

describe("StubGitService", () => {
  it("returns empty baseline status", async () => {
    const service = new StubGitService();
    await expect(service.status({ repoPath: "/repo" })).resolves.toEqual({
      repoPath: "/repo",
      currentBranch: "main",
      staged: [],
      unstaged: [],
      untracked: [],
      conflicts: [],
      ahead: 0,
      behind: 0,
    });
  });

  it("returns baseline branches and log", async () => {
    const service = new StubGitService();

    await expect(service.listBranches({ repoPath: "/repo" })).resolves.toEqual([
      "main",
    ]);
    await expect(service.log({ repoPath: "/repo" })).resolves.toEqual([]);
  });

  it("throws UnsupportedOperation for unimplemented methods", async () => {
    const service = new StubGitService();

    await expect(
      service.add({ repoPath: "/repo", filepath: ["a.md"] }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<GitError>>({
        name: "GitError",
        code: "UnsupportedOperation",
      }),
    );
  });
});
