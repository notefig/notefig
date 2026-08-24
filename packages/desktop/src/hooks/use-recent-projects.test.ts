import { describe, expect, it } from "vitest";
import { deriveProjectName } from "@/hooks/use-recent-projects";

describe("deriveProjectName", () => {
  it("takes the last segment of a mac-style path", () => {
    expect(deriveProjectName("/Users/x/project")).toBe("project");
  });

  it("takes the last segment of a windows-style path", () => {
    expect(deriveProjectName("C:\\Users\\x\\project")).toBe("project");
  });

  it("ignores a trailing separator", () => {
    expect(deriveProjectName("/Users/x/project/")).toBe("project");
    expect(deriveProjectName("C:\\Users\\x\\project\\")).toBe("project");
  });

  it("returns the whole string when it has only one segment", () => {
    expect(deriveProjectName("project")).toBe("project");
  });

  it("prefers an explicit name over the derived one", () => {
    expect(deriveProjectName("C:\\Users\\x\\project", "My Project")).toBe(
      "My Project",
    );
  });
});
