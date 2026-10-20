import { describe, it, expect } from "vitest";
import { resolveImageCandidates } from "../use-image-url";

describe("resolveImageCandidates", () => {
  const baseDirs = ["/ws/.notefig/scratchpads", "/ws"];

  it("tries the containing file's directory before the workspace root", () => {
    expect(resolveImageCandidates("assets/pic.png", baseDirs)).toEqual([
      "/ws/.notefig/scratchpads/assets/pic.png",
      "/ws/assets/pic.png",
    ]);
  });

  it("resolves ../ from the file's directory", () => {
    expect(resolveImageCandidates("../assets/pic.png", baseDirs)).toEqual([
      "/ws/.notefig/assets/pic.png",
    ]);
  });

  it("resolves ../../ from the file's directory to the workspace root", () => {
    expect(resolveImageCandidates("../../assets/pic.png", baseDirs)).toEqual([
      "/ws/assets/pic.png",
    ]);
  });

  it("dedupes when the file lives at the workspace root", () => {
    expect(resolveImageCandidates("assets/pic.png", ["/ws"])).toEqual([
      "/ws/assets/pic.png",
    ]);
  });

  it("passes an absolute in-workspace path through", () => {
    expect(resolveImageCandidates("/ws/assets/pic.png", baseDirs)).toEqual([
      "/ws/assets/pic.png",
    ]);
  });

  it("refuses paths that resolve outside the workspace", () => {
    expect(resolveImageCandidates("../../../etc/passwd", baseDirs)).toEqual([]);
    expect(resolveImageCandidates("/etc/passwd", baseDirs)).toEqual([]);
  });
});
