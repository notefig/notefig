import { describe, it, expect, vi } from "vitest";
import {
  BaseBrowserAdapter,
  filterFilePaths,
  buildSearchPattern,
  searchFileContent,
} from "../base-browser-adapter";
import type {
  Result,
  BatchResult,
  FileSystemMetadata,
  SearchMatch,
  SearchOptions,
} from "../platform-adapter.interface";
import { processPool } from "@/utils/process-pool";

/**
 * Concrete test adapter that lets us control readDirectory/readFiles responses.
 * Implements searchContent using the same pattern as BrowserPlatformAdapter.
 */
class TestAdapter extends BaseBrowserAdapter {
  files: Record<string, string> = {};

  async pickDirectory(): Promise<string | null> {
    return null;
  }

  async readDirectory(
    path: string,
    options?: {
      recursive?: boolean;
      includeFiles?: boolean;
      includeDirectories?: boolean;
    },
  ): Promise<Result<string[]>> {
    const prefix = path.endsWith("/") ? path : path + "/";
    const paths = Object.keys(this.files).filter((p) => p.startsWith(prefix));
    return { ok: true, value: paths };
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
    paths: string[],
  ): Promise<BatchResult<{ path: string; content: string }>> {
    const succeeded = paths
      .filter((p) => p in this.files)
      .map((p) => ({ path: p, content: this.files[p] }));
    return { succeeded, failed: [] };
  }

  async readBinaryFiles(
    paths: string[],
  ): Promise<BatchResult<{ path: string; data: Uint8Array }>> {
    const succeeded = paths
      .filter((p) => p in this.files)
      .map((p) => ({ path: p, data: new TextEncoder().encode(this.files[p]) }));
    return { succeeded, failed: [] };
  }

  async writeFiles(): Promise<BatchResult<string>> {
    return { succeeded: [], failed: [] };
  }

  async deleteFiles(): Promise<BatchResult<string>> {
    return { succeeded: [], failed: [] };
  }

  async writeBinaryFiles(): Promise<BatchResult<string>> {
    return { succeeded: [], failed: [] };
  }

  async resolveAssetUrl(relativePath: string): Promise<string> {
    return relativePath;
  }

  async exists(): Promise<
    { path: string; exists: boolean; type?: "file" | "directory" }[]
  > {
    return [];
  }

  async getMetadata(): Promise<BatchResult<FileSystemMetadata>> {
    return { succeeded: [], failed: [] };
  }

  async searchContent(
    directory: string,
    options: SearchOptions,
  ): Promise<SearchMatch[]> {
    const maxResults = options.maxResults ?? 1000;

    const dirResult = await this.readDirectory(directory, {
      recursive: true,
      includeFiles: true,
      includeDirectories: false,
    });

    if (!dirResult.ok) return [];

    const filePaths = filterFilePaths(dirResult.value, options);
    const pattern = buildSearchPattern(options);
    if (!pattern) return [];

    const { succeeded } = await processPool(
      filePaths,
      async (filePath: string) => {
        const readResult = await this.readFiles([filePath]);
        if (readResult.succeeded.length === 0) return [];
        const file = readResult.succeeded[0];
        const workerPattern = new RegExp(pattern.source, pattern.flags);
        return searchFileContent(file.path, file.content, workerPattern);
      },
      {
        concurrency: 6,
        shouldContinue: (r) => r.length < maxResults,
      },
    );

    return succeeded.slice(0, maxResults);
  }
}

describe("BaseBrowserAdapter.searchContent", () => {
  function createAdapter(files: Record<string, string>): TestAdapter {
    const adapter = new TestAdapter();
    adapter.files = files;
    return adapter;
  }

  it("should find literal matches across files", async () => {
    const adapter = createAdapter({
      "/workspace/file1.md": "hello world\ngoodbye world",
      "/workspace/file2.md": "no match here",
      "/workspace/file3.md": "hello again",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "hello",
    });

    expect(results).toHaveLength(2);
    expect(results[0].location.filePath).toBe("/workspace/file1.md");
    expect(results[0].location.range.start).toEqual({ line: 1, column: 1 });
    expect(results[0].location.range.end).toEqual({ line: 1, column: 6 });
    expect(results[0].content.matchText).toBe("hello");
    expect(results[0].content.lineContent).toBe("hello world");

    expect(results[1].location.filePath).toBe("/workspace/file3.md");
    expect(results[1].location.range.start).toEqual({ line: 1, column: 1 });
  });

  it("should find multiple matches on the same line", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "foo bar foo baz foo",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "foo",
    });

    expect(results).toHaveLength(3);
    expect(results[0].location.range.start.column).toBe(1);
    expect(results[1].location.range.start.column).toBe(9);
    expect(results[2].location.range.start.column).toBe(17);
  });

  it("should be case-insensitive by default", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "Hello HELLO hello",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "hello",
    });

    expect(results).toHaveLength(3);
  });

  it("should support case-sensitive search", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "Hello HELLO hello",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "hello",
      caseSensitive: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].location.range.start.column).toBe(13);
  });

  it("should support regex search", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "foo123 bar456 baz",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "\\w+\\d+",
      useRegex: true,
    });

    expect(results).toHaveLength(2);
    expect(results[0].content.matchText).toBe("foo123");
    expect(results[1].content.matchText).toBe("bar456");
  });

  it("should return empty for invalid regex", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "content",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "[invalid",
      useRegex: true,
    });

    expect(results).toHaveLength(0);
  });

  it("should escape special regex characters in literal search", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "price is $100.00 (USD)",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "$100.00",
    });

    expect(results).toHaveLength(1);
    expect(results[0].content.matchText).toBe("$100.00");
  });

  it("should respect maxResults", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "a\na\na\na\na\na\na\na\na\na",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "a",
      maxResults: 3,
    });

    expect(results).toHaveLength(3);
  });

  it("should filter by file pattern", async () => {
    const adapter = createAdapter({
      "/workspace/readme.md": "hello",
      "/workspace/code.ts": "hello",
      "/workspace/style.css": "hello",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "hello",
      filePattern: "*.md",
    });

    expect(results).toHaveLength(1);
    expect(results[0].location.filePath).toBe("/workspace/readme.md");
  });

  it("should filter by fileIncludes", async () => {
    const adapter = createAdapter({
      "/workspace/src/app.ts": "hello",
      "/workspace/node_modules/lib.ts": "hello",
      "/workspace/dist/bundle.js": "hello",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "hello",
      fileIncludes: ["/workspace/src/app.ts"],
    });

    expect(results).toHaveLength(1);
    expect(results[0].location.filePath).toBe("/workspace/src/app.ts");
  });

  it("should skip binary files", async () => {
    const adapter = createAdapter({
      "/workspace/readme.md": "hello",
      "/workspace/image.png": "hello",
      "/workspace/font.woff2": "hello",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "hello",
    });

    expect(results).toHaveLength(1);
    expect(results[0].location.filePath).toBe("/workspace/readme.md");
  });

  it("should handle multi-line files correctly", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "line one\nline two\nline three",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "line",
    });

    expect(results).toHaveLength(3);
    expect(results[0].location.range.start.line).toBe(1);
    expect(results[1].location.range.start.line).toBe(2);
    expect(results[2].location.range.start.line).toBe(3);
  });

  it("should return empty array for no matches", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "nothing relevant here",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "xyz",
    });

    expect(results).toHaveLength(0);
  });

  it("should handle empty files", async () => {
    const adapter = createAdapter({
      "/workspace/empty.md": "",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "hello",
    });

    expect(results).toHaveLength(0);
  });

  it("should return empty when readDirectory fails", async () => {
    const adapter = new TestAdapter();
    vi.spyOn(adapter, "readDirectory").mockResolvedValue({
      ok: false,
      error: { path: "/workspace", type: "io_error", message: "fail" },
    });

    const results = await adapter.searchContent("/workspace", {
      query: "hello",
    });

    expect(results).toHaveLength(0);
  });

  it("should handle zero-width regex matches without infinite loop", async () => {
    const adapter = createAdapter({
      "/workspace/file.md": "abc",
    });

    const results = await adapter.searchContent("/workspace", {
      query: "(?=a)",
      useRegex: true,
      maxResults: 10,
    });

    // Should not hang - zero-width match at position 0
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});
