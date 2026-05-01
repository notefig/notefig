import { describe, it, expect, beforeEach } from "vitest";
import { BaseBrowserAdapter } from "../base-browser-adapter";
import type {
  BatchResult,
  FileSystemError,
  FileSystemMetadata,
  Result,
} from "../platform-adapter.interface";

// Create a minimal concrete implementation for testing
class TestBrowserAdapter extends BaseBrowserAdapter {
  private files = new Map<string, Uint8Array>();

  async pickDirectory(): Promise<string | null> {
    return null;
  }
  async readDirectory(): Promise<Result<string[]>> {
    return { ok: true, value: [] };
  }
  async createDirectories(): Promise<BatchResult<string>> {
    return { succeeded: [], failed: [] };
  }
  async deleteDirectories(): Promise<BatchResult<string>> {
    return { succeeded: [], failed: [] };
  }
  async moveDirectory(): Promise<Result<void>> {
    return { ok: true, value: undefined };
  }
  async readFiles(
    _paths: string[],
  ): Promise<BatchResult<{ path: string; content: string }>> {
    return { succeeded: [], failed: [] };
  }
  async readBinaryFiles(): Promise<
    BatchResult<{ path: string; data: Uint8Array }>
  > {
    const succeeded: Array<{ path: string; data: Uint8Array }> = [];
    const failed: FileSystemError[] = [];

    for (const [path, data] of this.files.entries()) {
      succeeded.push({ path, data });
    }

    return { succeeded, failed };
  }
  async writeFiles(
    _files: { path: string; content: string }[],
  ): Promise<BatchResult<string>> {
    return { succeeded: [], failed: [] };
  }
  async deleteFiles(_paths: string[]): Promise<BatchResult<string>> {
    const succeeded: string[] = [];
    for (const path of _paths) {
      this.files.delete(path);
      succeeded.push(path);
    }
    return { succeeded, failed: [] };
  }
  async exists() {
    return [];
  }
  async getMetadata(): Promise<BatchResult<FileSystemMetadata>> {
    return { succeeded: [], failed: [] };
  }
  async writeBinaryFiles(
    _files: { path: string; data: Uint8Array }[],
  ): Promise<BatchResult<string>> {
    for (const file of _files) {
      this.files.set(file.path, file.data);
    }
    return { succeeded: _files.map((file) => file.path), failed: [] };
  }
  async resolveAssetUrl(): Promise<string> {
    return "";
  }
  async searchContent() {
    return [];
  }

  async seedBinaryFile(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }

  async readSeededBinaryFile(path: string): Promise<Uint8Array | undefined> {
    return this.files.get(path);
  }
}

describe("BaseBrowserAdapter KV Store", () => {
  let adapter: TestBrowserAdapter;

  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    adapter = new TestBrowserAdapter();
  });

  describe("setKv and getKv", () => {
    it("should store and retrieve values", async () => {
      await adapter.setKv("test", "key1", { name: "value1" });
      const result = await adapter.getKv("test", "key1");
      expect(result).toEqual({ name: "value1" });
    });

    it("should return undefined for non-existent keys", async () => {
      const result = await adapter.getKv("test", "nonexistent");
      expect(result).toBeUndefined();
    });

    it("should handle different namespaces independently", async () => {
      await adapter.setKv("ns1", "key", "value1");
      await adapter.setKv("ns2", "key", "value2");

      const result1 = await adapter.getKv("ns1", "key");
      const result2 = await adapter.getKv("ns2", "key");

      expect(result1).toBe("value1");
      expect(result2).toBe("value2");
    });

    it("should handle complex objects", async () => {
      const data = {
        nested: { value: 123 },
        array: [1, 2, 3],
        string: "test",
        boolean: true,
      };
      await adapter.setKv("complex", "obj", data);
      const result = await adapter.getKv("complex", "obj");
      expect(result).toEqual(data);
    });
  });

  describe("deleteKv", () => {
    it("should remove keys", async () => {
      await adapter.setKv("test", "key", "value");
      await adapter.deleteKv("test", "key");
      const result = await adapter.getKv("test", "key");
      expect(result).toBeUndefined();
    });

    it("should not affect other keys in same namespace", async () => {
      await adapter.setKv("test", "key1", "value1");
      await adapter.setKv("test", "key2", "value2");
      await adapter.deleteKv("test", "key1");

      const result = await adapter.getKv("test", "key2");
      expect(result).toBe("value2");
    });
  });

  describe("getAllKv", () => {
    it("should return all values in a namespace", async () => {
      await adapter.setKv("test", "key1", "value1");
      await adapter.setKv("test", "key2", "value2");
      await adapter.setKv("other", "key3", "value3");

      const result = await adapter.getAllKv("test");
      expect(result).toEqual({
        key1: "value1",
        key2: "value2",
      });
    });

    it("should return empty object for empty namespace", async () => {
      const result = await adapter.getAllKv("empty");
      expect(result).toEqual({});
    });
  });

  describe("binary move/copy", () => {
    it("copies binary content without text transcoding", async () => {
      const sourcePath = "/workspace/image.png";
      const targetPath = "/workspace/copy.png";
      const bytes = new Uint8Array([0, 255, 16, 127, 13, 10]);

      await adapter.seedBinaryFile(sourcePath, bytes);

      const result = await adapter.copyFile(sourcePath, targetPath);
      expect(result.ok).toBe(true);

      const copied = await adapter.readSeededBinaryFile(targetPath);
      expect(copied).toEqual(bytes);
    });

    it("moves binary content without text transcoding", async () => {
      const sourcePath = "/workspace/from/image.png";
      const targetPath = "/workspace/to/image.png";
      const bytes = new Uint8Array([255, 0, 128, 64, 13, 10]);

      await adapter.seedBinaryFile(sourcePath, bytes);

      const result = await adapter.moveFile(sourcePath, targetPath);
      expect(result.ok).toBe(true);

      const moved = await adapter.readSeededBinaryFile(targetPath);
      const source = await adapter.readSeededBinaryFile(sourcePath);
      expect(moved).toEqual(bytes);
      expect(source).toBeUndefined();
    });
  });
});
