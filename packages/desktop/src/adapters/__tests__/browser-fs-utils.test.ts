import { describe, it, expect } from "vitest";
import {
  normalizeWorkspacePath,
  getWorkspaceRoot,
  getRelativePath,
  isHiddenPath,
  buildAbsolutePath,
} from "../browser-fs-utils";

describe("normalizeWorkspacePath", () => {
  it("should add leading slash to folder name", () => {
    expect(normalizeWorkspacePath("my-folder")).toBe("/my-folder");
  });

  it("should remove trailing slashes", () => {
    expect(normalizeWorkspacePath("my-folder/")).toBe("/my-folder");
  });

  it("should remove multiple leading slashes", () => {
    expect(normalizeWorkspacePath("///my-folder")).toBe("/my-folder");
  });

  it("should handle empty string", () => {
    expect(normalizeWorkspacePath("")).toBe("/untitled");
  });

  it("should handle string with only slashes", () => {
    expect(normalizeWorkspacePath("///")).toBe("/untitled");
  });

  it("should preserve folder names with spaces", () => {
    expect(normalizeWorkspacePath("My Documents")).toBe("/My Documents");
  });

  it("should preserve folder names with special characters", () => {
    expect(normalizeWorkspacePath("project-v2.0_beta")).toBe(
      "/project-v2.0_beta",
    );
  });
});

describe("getWorkspaceRoot", () => {
  it("should extract root from simple path", () => {
    expect(getWorkspaceRoot("/my-folder")).toBe("/my-folder");
  });

  it("should extract root from nested path", () => {
    expect(getWorkspaceRoot("/my-folder/docs/file.md")).toBe("/my-folder");
  });

  it("should return null for empty path", () => {
    expect(getWorkspaceRoot("")).toBeNull();
  });

  it("should return null for root only", () => {
    expect(getWorkspaceRoot("/")).toBeNull();
  });

  it("should handle multiple slashes", () => {
    expect(getWorkspaceRoot("///my-folder///sub")).toBe("/my-folder");
  });

  it("should handle single segment path", () => {
    expect(getWorkspaceRoot("/workspace")).toBe("/workspace");
  });
});

describe("getRelativePath", () => {
  it("should return empty string when path equals root", () => {
    expect(getRelativePath("/my-folder", "/my-folder")).toBe("");
  });

  it("should extract relative path from nested path", () => {
    expect(getRelativePath("/my-folder/docs/file.md", "/my-folder")).toBe(
      "docs/file.md",
    );
  });

  it("should handle direct child", () => {
    expect(getRelativePath("/my-folder/README.md", "/my-folder")).toBe(
      "README.md",
    );
  });

  it("should return empty string for non-matching root", () => {
    expect(getRelativePath("/other-folder/file.md", "/my-folder")).toBe("");
  });

  it("should handle paths with spaces", () => {
    expect(getRelativePath("/My Project/docs/file.md", "/My Project")).toBe(
      "docs/file.md",
    );
  });
});

describe("isHiddenPath", () => {
  it("should return false for normal paths", () => {
    expect(isHiddenPath("/workspace/docs/file.md")).toBe(false);
  });

  it("should return true for paths with hidden segments", () => {
    expect(isHiddenPath("/workspace/.git/config")).toBe(true);
  });

  it("should return true for hidden file at root", () => {
    expect(isHiddenPath("/workspace/.env")).toBe(true);
  });

  it("should return false for single dot (current directory)", () => {
    expect(isHiddenPath("/workspace/./file.md")).toBe(false);
  });

  it("should return false for double dot (parent directory)", () => {
    expect(isHiddenPath("/workspace/../file.md")).toBe(false);
  });

  it("should return true if any segment is hidden", () => {
    expect(isHiddenPath("/workspace/src/.hidden/file.md")).toBe(true);
  });

  it("should return false for empty string", () => {
    expect(isHiddenPath("")).toBe(false);
  });

  it("should handle paths with multiple hidden segments", () => {
    expect(isHiddenPath("/.hidden/.secret/file")).toBe(true);
  });
});

describe("buildAbsolutePath", () => {
  it("should return root when relPath is empty", () => {
    expect(buildAbsolutePath("/my-folder", "")).toBe("/my-folder");
  });

  it("should join root and relative path", () => {
    expect(buildAbsolutePath("/my-folder", "docs/file.md")).toBe(
      "/my-folder/docs/file.md",
    );
  });

  it("should handle single file", () => {
    expect(buildAbsolutePath("/my-folder", "README.md")).toBe(
      "/my-folder/README.md",
    );
  });

  it("should handle root with trailing slash", () => {
    expect(buildAbsolutePath("/my-folder/", "docs/file.md")).toBe(
      "/my-folder/docs/file.md",
    );
  });

  it("should handle nested relative paths", () => {
    expect(buildAbsolutePath("/my-folder", "src/components/Button.tsx")).toBe(
      "/my-folder/src/components/Button.tsx",
    );
  });
});
