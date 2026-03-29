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
  async readFiles(): Promise<BatchResult<{ path: string; content: string }>> {
    return { succeeded: [], failed: [] };
  }
  async writeFiles(): Promise<BatchResult<string>> {
    return { succeeded: [], failed: [] };
  }
  async deleteFiles(): Promise<BatchResult<string>> {
    return { succeeded: [], failed: [] };
  }
  async exists() {
    return [];
  }
  async getMetadata(): Promise<BatchResult<FileSystemMetadata>> {
    return { succeeded: [], failed: [] };
  }
  async writeBinaryFiles(): Promise<BatchResult<string>> {
    return { succeeded: [], failed: [] };
  }
  async resolveAssetUrl(): Promise<string> {
    return "";
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
});
