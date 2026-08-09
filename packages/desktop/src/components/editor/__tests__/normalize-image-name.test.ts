import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  normalizeImageName,
  dedupeAssetName,
} from "@/components/editor/editor-image-paste";
import { platformAdapter } from "@/adapters";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
    fs: {
      exists: vi.fn(),
    },
  },
}));

const existsMock = vi.mocked(platformAdapter.fs.exists);

/** Make exists() report the given asset paths as taken. */
function seedExisting(paths: string[]) {
  const taken = new Set(paths);
  existsMock.mockImplementation(async (queried: string[]) =>
    queried.map((path) => ({ path, exists: taken.has(path) })),
  );
}

describe("normalizeImageName", () => {
  it("replaces spaces with hyphens", () => {
    expect(normalizeImageName("image (1).jpg")).toBe("image-1.jpg");
  });

  it("collapses multiple spaces into a single hyphen", () => {
    expect(normalizeImageName("my   photo.png")).toBe("my-photo.png");
  });

  it("removes parentheses", () => {
    expect(normalizeImageName("photo(1).png")).toBe("photo1.png");
  });

  it("handles names with both spaces and parentheses", () => {
    expect(normalizeImageName("Screen Shot (2).png")).toBe("Screen-Shot-2.png");
  });

  it("passes through names with no special chars", () => {
    expect(normalizeImageName("photo.png")).toBe("photo.png");
  });

  it("passes through already-normalized names", () => {
    expect(normalizeImageName("pasted-12345.png")).toBe("pasted-12345.png");
  });
});

describe("dedupeAssetName", () => {
  beforeEach(() => {
    existsMock.mockReset();
  });

  it("keeps a free name unchanged", async () => {
    seedExisting([]);
    await expect(dedupeAssetName("/ws", "photo.png")).resolves.toBe(
      "photo.png",
    );
  });

  it("suffixes -1 before the extension on collision", async () => {
    seedExisting(["/ws/assets/photo.png"]);
    await expect(dedupeAssetName("/ws", "photo.png")).resolves.toBe(
      "photo-1.png",
    );
  });

  it("keeps counting past taken suffixes", async () => {
    seedExisting([
      "/ws/assets/photo.png",
      "/ws/assets/photo-1.png",
      "/ws/assets/photo-2.png",
    ]);
    await expect(dedupeAssetName("/ws", "photo.png")).resolves.toBe(
      "photo-3.png",
    );
  });

  it("handles extensionless names", async () => {
    seedExisting(["/ws/assets/photo"]);
    await expect(dedupeAssetName("/ws", "photo")).resolves.toBe("photo-1");
  });

  it("treats a leading dot as part of the stem, not an extension", async () => {
    seedExisting([]);
    await expect(dedupeAssetName("/ws", ".hidden")).resolves.toBe(".hidden");
  });
});
