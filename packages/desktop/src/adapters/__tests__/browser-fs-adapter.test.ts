import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  BrowserFsPlatformAdapter,
  shouldUseBrowserFsAdapter,
} from "../browser-fs-adapter";
import * as browserFsUtils from "../browser-fs-utils";

vi.mock("../browser-fs-utils", () => ({
  normalizeWorkspacePath: vi.fn((name: string) => `/${name}`),
  getWorkspaceRoot: vi.fn((path: string) => {
    if (!path || path === "/") return null;
    const parts = path.split("/").filter(Boolean);
    return parts.length > 0 ? `/${parts[0]}` : null;
  }),
  getRelativePath: vi.fn((path: string, root: string) => {
    if (!path.startsWith(root)) return "";
    const rel = path.slice(root.length);
    return rel.startsWith("/") ? rel.slice(1) : rel;
  }),
  ensurePermission: vi.fn(),
  buildAbsolutePath: vi.fn((root: string, rel: string) => {
    if (!rel) return root;
    return `${root}/${rel}`;
  }),
  isHiddenPath: vi.fn((path: string) => {
    const parts = path.split("/");
    return parts.some((part) => part.startsWith(".") && part.length > 1);
  }),
  createError: vi.fn((path: string, type: string, message: string) => ({
    path,
    type,
    message,
  })),
}));

vi.mock("@/utils/hash", () => ({
  calculateContentHash: vi.fn((content: string) => `hash-${content}`),
}));

describe("BrowserFsPlatformAdapter", () => {
  let adapter: BrowserFsPlatformAdapter;
  let mockDirectoryHandle: any;
  let mockFileHandle: any;
  let mockFile: any;
  let mockWritable: any;
  let fileWatcherMock: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock file system objects
    mockWritable = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockFile = {
      text: vi.fn().mockResolvedValue("file content"),
      arrayBuffer: vi
        .fn()
        .mockResolvedValue(new TextEncoder().encode("file content").buffer),
      size: 100,
      lastModified: Date.now(),
    };

    mockFileHandle = {
      getFile: vi.fn().mockResolvedValue(mockFile),
      createWritable: vi.fn().mockResolvedValue(mockWritable),
      kind: "file",
      name: "test.txt",
    };

    mockDirectoryHandle = {
      name: "test-workspace",
      kind: "directory",
      entries: vi.fn(),
      getDirectoryHandle: vi.fn().mockResolvedValue(mockDirectoryHandle),
      getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      removeEntry: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn(),
      values: vi.fn(),
    };

    global.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock-url");
    global.URL.revokeObjectURL = vi.fn();

    (global as any).window = {
      showDirectoryPicker: vi.fn().mockResolvedValue(mockDirectoryHandle),
      __VITE_INDEXEDDB_NAME__: undefined,
    };

    Object.defineProperty(navigator, "webdriver", {
      value: undefined,
      configurable: true,
    });

    const mockIDBRequest = {
      result: {
        transaction: vi.fn().mockReturnValue({
          objectStore: vi.fn().mockReturnValue({
            get: vi.fn().mockReturnValue({
              set onsuccess(fn: any) {
                setTimeout(
                  () =>
                    fn({ target: { result: { handle: mockDirectoryHandle } } }),
                  0,
                );
              },
            }),
            put: vi.fn().mockReturnValue({
              set onsuccess(fn: any) {
                setTimeout(() => fn({ target: {} }), 0);
              },
            }),
          }),
          oncomplete: null,
        }),
        objectStoreNames: { contains: vi.fn().mockReturnValue(true) },
        createObjectStore: vi.fn(),
        close: vi.fn(),
      },
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    } as any;

    (global as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        setTimeout(() => {
          if ((mockIDBRequest as any).onsuccess) {
            (mockIDBRequest as any).onsuccess({ target: mockIDBRequest });
          }
        }, 0);
        return mockIDBRequest;
      }),
      deleteDatabase: vi.fn(),
    };

    (global as any).indexedDB = {
      open: vi.fn().mockImplementation(() => {
        setTimeout(() => {
          if (mockIDBRequest.onsuccess) {
            mockIDBRequest.onsuccess({ target: mockIDBRequest });
          }
        }, 0);
        return mockIDBRequest;
      }),
      deleteDatabase: vi.fn(),
    };

    fileWatcherMock = {
      registerAppWrite: vi.fn(),
      startWatchingMetadata: vi.fn().mockResolvedValue(undefined),
      startWatchingContent: vi.fn().mockResolvedValue(undefined),
      stopWatching: vi.fn(),
      addEventListener: vi.fn((callback: any) => {
        return () => {
          fileWatcherMock.removeEventListener(callback);
        };
      }),
      removeEventListener: vi.fn(),
    };

    adapter = new BrowserFsPlatformAdapter();

    (adapter as any).fileWatcher = fileWatcherMock;

    (adapter as any).handleCache.set("/test-workspace", mockDirectoryHandle);
    (adapter as any).db = mockIDBRequest.result;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("pickDirectory", () => {
    it("should call showDirectoryPicker and return normalized path", async () => {
      const storeHandleSpy = vi
        .spyOn(adapter as any, "storeHandle")
        .mockResolvedValue(undefined);

      const result = await adapter.pickDirectory("Select Folder");

      expect(window.showDirectoryPicker).toHaveBeenCalled();
      expect(browserFsUtils.ensurePermission).toHaveBeenCalledWith(
        mockDirectoryHandle,
        "readwrite",
      );
      expect(browserFsUtils.normalizeWorkspacePath).toHaveBeenCalledWith(
        "test-workspace",
      );
      expect(result).toBe("/test-workspace");
      expect(storeHandleSpy).toHaveBeenCalled();
    }, 10000);

    it("should handle user cancellation", async () => {
      (window as any).showDirectoryPicker = vi
        .fn()
        .mockRejectedValue(new Error("User cancelled"));

      const result = await adapter.pickDirectory("Select Folder");

      expect(result).toBeNull();
    });

    it("should handle permission errors", async () => {
      vi.mocked(browserFsUtils.ensurePermission).mockRejectedValue(
        new Error("Permission denied"),
      );

      const result = await adapter.pickDirectory("Select Folder");

      expect(result).toBeNull();
    });
  });

  describe("readDirectory", () => {
    it("should list files recursively", async () => {
      const subDirHandle = {
        kind: "directory",
        name: "subdir",
        entries: vi.fn().mockReturnValue(
          (async function* () {
            yield ["file2.txt", mockFileHandle];
          })(),
        ),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      };

      let callCount = 0;
      mockDirectoryHandle.entries = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return (async function* () {
            yield ["file1.txt", mockFileHandle];
            yield ["subdir", subDirHandle];
          })();
        }
        return (async function* () {})();
      });

      mockDirectoryHandle.getDirectoryHandle = vi
        .fn()
        .mockResolvedValue(subDirHandle);

      const result = await adapter.readDirectory("/test-workspace", {
        recursive: true,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toContain("/test-workspace/file1.txt");
        expect(result.value).toContain("/test-workspace/subdir");
        expect(result.value).toContain("/test-workspace/subdir/file2.txt");
      }
    });

    it("should list files non-recursively", async () => {
      const entriesIterator = (async function* () {
        yield ["file1.txt", mockFileHandle];
        yield ["subdir", { kind: "directory" }];
      })();

      mockDirectoryHandle.entries = vi.fn().mockReturnValue(entriesIterator);

      const result = await adapter.readDirectory("/test-workspace", {
        recursive: false,
      });

      expect(result.ok).toBe(true);
    });

    it("should filter hidden files/directories", async () => {
      vi.mocked(browserFsUtils.isHiddenPath).mockImplementation(
        (path: string) => {
          return path.includes(".") && !path.startsWith("./");
        },
      );

      const entriesIterator = (async function* () {
        yield [".git", { kind: "directory" }];
        yield ["file1.txt", mockFileHandle];
        yield [".env", mockFileHandle];
      })();

      mockDirectoryHandle.entries = vi.fn().mockReturnValue(entriesIterator);

      const result = await adapter.readDirectory("/test-workspace");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toContain("/test-workspace/.git");
        expect(result.value).not.toContain("/test-workspace/.env");
      }
    });

    it("should handle paths with trailing slashes", async () => {
      const entriesIterator = (async function* () {
        yield ["file1.txt", mockFileHandle];
      })();

      mockDirectoryHandle.entries = vi.fn().mockReturnValue(entriesIterator);

      const result = await adapter.readDirectory("/test-workspace/");

      expect(result.ok).toBe(true);
      expect(browserFsUtils.getWorkspaceRoot).toHaveBeenCalledWith(
        "/test-workspace/",
      );
    });

    it("should return error for invalid workspace path", async () => {
      vi.mocked(browserFsUtils.getWorkspaceRoot).mockReturnValue(null);

      const result = await adapter.readDirectory("invalid");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe("io_error");
      }
    });

    it("should handle includeFiles option", async () => {
      const entriesIterator = (async function* () {
        yield ["file1.txt", mockFileHandle];
        yield ["subdir", { kind: "directory" }];
      })();

      mockDirectoryHandle.entries = vi.fn().mockReturnValue(entriesIterator);

      const resultWithFiles = await adapter.readDirectory("/test-workspace", {
        includeFiles: true,
        includeDirectories: false,
      });

      expect(resultWithFiles.ok).toBe(true);
    });

    it("should handle includeDirectories option", async () => {
      const entriesIterator = (async function* () {
        yield ["file1.txt", mockFileHandle];
        yield ["subdir", { kind: "directory" }];
      })();

      mockDirectoryHandle.entries = vi.fn().mockReturnValue(entriesIterator);

      const resultWithDirs = await adapter.readDirectory("/test-workspace", {
        includeFiles: false,
        includeDirectories: true,
      });

      expect(resultWithDirs.ok).toBe(true);
    });
  });

  describe("readFiles", () => {
    it("should read multiple files in batch", async () => {
      const result = await adapter.readFiles([
        "/test-workspace/file1.txt",
        "/test-workspace/file2.txt",
      ]);

      expect(result.succeeded.length).toBe(2);
      expect(result.succeeded[0]).toEqual({
        path: "/test-workspace/file1.txt",
        content: "file content",
      });
    });

    it("should return partial success (some found, some not)", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockResolvedValueOnce(mockFileHandle)
        .mockRejectedValueOnce(new Error("File not found"));

      const result = await adapter.readFiles([
        "/test-workspace/file1.txt",
        "/test-workspace/missing.txt",
      ]);

      expect(result.succeeded.length).toBe(1);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0].path).toBe("/test-workspace/missing.txt");
    });

    it("should return empty content for empty files", async () => {
      mockFile.text = vi.fn().mockResolvedValue("");

      const result = await adapter.readFiles(["/test-workspace/empty.txt"]);

      expect(result.succeeded.length).toBe(1);
      expect(result.succeeded[0].content).toBe("");
    });
  });

  describe("readBinaryFiles", () => {
    it("should read multiple binary files in batch", async () => {
      const result = await adapter.readBinaryFiles([
        "/test-workspace/file1.bin",
        "/test-workspace/file2.bin",
      ]);

      expect(result.succeeded.length).toBe(2);
      expect(result.succeeded[0].path).toBe("/test-workspace/file1.bin");
      expect(result.succeeded[0].data).toBeInstanceOf(Uint8Array);
    });

    it("should return partial success for missing binary files", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockResolvedValueOnce(mockFileHandle)
        .mockRejectedValueOnce(new Error("File not found"));

      const result = await adapter.readBinaryFiles([
        "/test-workspace/file1.bin",
        "/test-workspace/missing.bin",
      ]);

      expect(result.succeeded.length).toBe(1);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0].path).toBe("/test-workspace/missing.bin");
    });
  });

  describe("writeFiles", () => {
    it("should write multiple files atomically", async () => {
      const files = [
        { path: "/test-workspace/file1.txt", content: "content1" },
        { path: "/test-workspace/file2.txt", content: "content2" },
      ];

      const result = await adapter.writeFiles(files);

      expect(result.succeeded.length).toBe(2);
      expect(mockWritable.write).toHaveBeenCalledWith("content1");
      expect(mockWritable.write).toHaveBeenCalledWith("content2");
      expect(mockWritable.close).toHaveBeenCalledTimes(2);
    });

    it("should handle special characters in content", async () => {
      const files = [
        { path: "/test-workspace/special.txt", content: "<&>\"'\n\t" },
      ];

      const result = await adapter.writeFiles(files);

      expect(result.succeeded.length).toBe(1);
      expect(mockWritable.write).toHaveBeenCalledWith("<&>\"'\n\t");
    });

    it("should return failed array for errors", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied"));

      const files = [{ path: "/test-workspace/file.txt", content: "content" }];

      const result = await adapter.writeFiles(files);

      expect(result.succeeded.length).toBe(0);
      expect(result.failed.length).toBe(1);
      expect(result.failed[0].type).toBe("io_error");
    });
  });

  describe("createDirectories", () => {
    it("should create directories", async () => {
      const paths = ["/test-workspace/newdir", "/test-workspace/nested/dir"];

      const result = await adapter.createDirectories(paths);

      expect(result.succeeded.length).toBe(2);
      expect(mockDirectoryHandle.getDirectoryHandle).toHaveBeenCalledWith(
        "newdir",
        { create: true },
      );
    });

    it("should handle failures", async () => {
      mockDirectoryHandle.getDirectoryHandle = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied"));

      const result = await adapter.createDirectories(["/test-workspace/dir"]);

      expect(result.succeeded.length).toBe(0);
      expect(result.failed.length).toBe(1);
    });
  });

  describe("deleteDirectories", () => {
    it("should delete directories and all children with recursive option", async () => {
      const result = await adapter.deleteDirectories(["/test-workspace/dir"], {
        recursive: true,
      });

      expect(result.succeeded.length).toBe(1);
      expect(mockDirectoryHandle.removeEntry).toHaveBeenCalledWith("dir", {
        recursive: true,
      });
    });

    it("should fail non-recursively if directory not empty", async () => {
      mockDirectoryHandle.removeEntry = vi
        .fn()
        .mockRejectedValue(new Error("Directory not empty"));

      const result = await adapter.deleteDirectories(["/test-workspace/dir"], {
        recursive: false,
      });

      expect(result.succeeded.length).toBe(0);
      expect(result.failed.length).toBe(1);
    });

    it("should handle multiple directories in batch", async () => {
      const result = await adapter.deleteDirectories(
        ["/test-workspace/dir1", "/test-workspace/dir2"],
        { recursive: true },
      );

      expect(result.succeeded.length).toBe(2);
      expect(mockDirectoryHandle.removeEntry).toHaveBeenCalledTimes(2);
    });
  });

  describe("moveDirectory", () => {
    it("should move directory and all children", async () => {
      const entriesIterator = (async function* () {
        yield ["file.txt", mockFileHandle];
      })();

      mockDirectoryHandle.entries = vi.fn().mockReturnValue(entriesIterator);

      const result = await adapter.moveDirectory(
        "/test-workspace/old",
        "/test-workspace/new",
      );

      expect(result.ok).toBe(true);
    });

    it("should update all file paths", async () => {
      const subDir = {
        kind: "directory",
        entries: vi.fn().mockReturnValue(
          (async function* () {
            yield ["b.txt", mockFileHandle];
          })(),
        ),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      };

      const entriesIterator = (async function* () {
        yield ["a.txt", mockFileHandle];
        yield ["sub", subDir];
      })();

      mockDirectoryHandle.entries = vi.fn().mockReturnValue(entriesIterator);
      mockDirectoryHandle.getDirectoryHandle = vi
        .fn()
        .mockResolvedValueOnce(subDir);

      const result = await adapter.moveDirectory(
        "/test-workspace/old",
        "/test-workspace/new",
      );

      expect(result.ok).toBe(true);
    });

    it("should fail if source doesn't exist", async () => {
      // Mock readDirectory to throw an error (simulating non-existent source)
      vi.spyOn(adapter, "readDirectory").mockRejectedValue(
        new Error("Source directory not found"),
      );

      const result = await adapter.moveDirectory(
        "/test-workspace/nonexistent",
        "/test-workspace/new",
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.type).toBe("io_error");
      }
    });

    it("should handle nested directory moves", async () => {
      const deepDir = {
        kind: "directory",
        entries: vi.fn().mockReturnValue(
          (async function* () {
            yield ["file.txt", mockFileHandle];
          })(),
        ),
        getDirectoryHandle: vi.fn(),
        getFileHandle: vi.fn().mockResolvedValue(mockFileHandle),
      };

      const subDir = {
        kind: "directory",
        entries: vi.fn().mockReturnValue(
          (async function* () {
            yield ["c", deepDir];
          })(),
        ),
        getDirectoryHandle: vi.fn().mockResolvedValue(deepDir),
        getFileHandle: vi.fn(),
      };

      const entriesIterator = (async function* () {
        yield ["b", subDir];
      })();

      mockDirectoryHandle.entries = vi.fn().mockReturnValue(entriesIterator);
      mockDirectoryHandle.getDirectoryHandle = vi
        .fn()
        .mockResolvedValueOnce(subDir);

      const result = await adapter.moveDirectory(
        "/test-workspace/a",
        "/test-workspace/x",
      );

      expect(result.ok).toBe(true);
    });
  });

  describe("deleteFiles", () => {
    it("should delete multiple files", async () => {
      const result = await adapter.deleteFiles([
        "/test-workspace/file1.txt",
        "/test-workspace/file2.txt",
      ]);

      expect(result.succeeded.length).toBe(2);
      expect(mockDirectoryHandle.removeEntry).toHaveBeenCalledTimes(2);
    });

    it("should handle non-existent files", async () => {
      mockDirectoryHandle.removeEntry = vi
        .fn()
        .mockRejectedValue(new Error("File not found"));

      const result = await adapter.deleteFiles(["/test-workspace/missing.txt"]);

      expect(result.succeeded.length).toBe(0);
      expect(result.failed.length).toBe(1);
    });
  });

  describe("moveFile", () => {
    it("should rename file in place", async () => {
      const result = await adapter.moveFile(
        "/test-workspace/old.txt",
        "/test-workspace/new.txt",
      );

      expect(result.ok).toBe(true);
    });

    it("should move file between directories", async () => {
      // Mock readFiles to return content from source
      vi.spyOn(adapter, "readFiles").mockResolvedValue({
        succeeded: [
          { path: "/test-workspace/a/file.txt", content: "file content" },
        ],
        failed: [],
      });

      // Mock writeFiles to succeed
      vi.spyOn(adapter, "writeFiles").mockResolvedValue({
        succeeded: ["/test-workspace/b/file.txt"],
        failed: [],
      });

      // Mock deleteFiles to succeed
      vi.spyOn(adapter, "deleteFiles").mockResolvedValue({
        succeeded: ["/test-workspace/a/file.txt"],
        failed: [],
      });

      const result = await adapter.moveFile(
        "/test-workspace/a/file.txt",
        "/test-workspace/b/file.txt",
      );

      expect(result.ok).toBe(true);
      expect(adapter.readFiles).toHaveBeenCalledWith([
        "/test-workspace/a/file.txt",
      ]);
      expect(adapter.writeFiles).toHaveBeenCalledWith([
        { path: "/test-workspace/b/file.txt", content: "file content" },
      ]);
      expect(adapter.deleteFiles).toHaveBeenCalledWith([
        "/test-workspace/a/file.txt",
      ]);
    });

    it("should fail if source doesn't exist", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockRejectedValue(new Error("Not found"));

      const result = await adapter.moveFile(
        "/test-workspace/missing.txt",
        "/test-workspace/new.txt",
      );

      expect(result.ok).toBe(false);
    });
  });

  describe("exists", () => {
    it("should check if files exist", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockResolvedValue(mockFileHandle);

      const result = await adapter.exists(["/test-workspace/file.txt"]);

      expect(result[0].exists).toBe(true);
      expect(result[0].type).toBe("file");
    });

    it("should check if directories exist", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockRejectedValue(new Error("Not a file"));
      mockDirectoryHandle.getDirectoryHandle = vi
        .fn()
        .mockResolvedValue(mockDirectoryHandle);

      const result = await adapter.exists(["/test-workspace/dir"]);

      expect(result[0].exists).toBe(true);
      expect(result[0].type).toBe("directory");
    });

    it("should return type for existing paths", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockResolvedValue(mockFileHandle);

      const result = await adapter.exists(["/test-workspace/file.txt"]);

      expect(result[0]).toHaveProperty("type", "file");
    });
  });

  describe("getMetadata", () => {
    it("should return file metadata (size, dates, type)", async () => {
      const result = await adapter.getMetadata(["/test-workspace/file.txt"]);

      expect(result.succeeded.length).toBe(1);
      expect(result.succeeded[0]).toMatchObject({
        path: "/test-workspace/file.txt",
        type: "file",
        size: 100,
      });
      expect(result.succeeded[0].modifiedAt).toBeInstanceOf(Date);
      expect(result.succeeded[0].createdAt).toBeInstanceOf(Date);
    });

    it("should return directory metadata", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockRejectedValue(new Error("Not a file"));
      mockDirectoryHandle.getDirectoryHandle = vi
        .fn()
        .mockResolvedValue(mockDirectoryHandle);

      const result = await adapter.getMetadata(["/test-workspace/dir"]);

      expect(result.succeeded.length).toBe(1);
      expect(result.succeeded[0]).toMatchObject({
        path: "/test-workspace/dir",
        type: "directory",
        size: 0,
      });
    });

    it("should fail for non-existent paths", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockRejectedValue(new Error("Not found"));
      mockDirectoryHandle.getDirectoryHandle = vi
        .fn()
        .mockRejectedValue(new Error("Not found"));

      const result = await adapter.getMetadata(["/test-workspace/missing"]);

      expect(result.succeeded.length).toBe(0);
      expect(result.failed.length).toBe(1);
    });

    it("should handle batch requests", async () => {
      const result = await adapter.getMetadata([
        "/test-workspace/file1.txt",
        "/test-workspace/file2.txt",
      ]);

      expect(result.succeeded.length).toBe(2);
    });
  });

  describe("writeBinaryFiles", () => {
    it("should write binary data as Uint8Array", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const files = [{ path: "/test-workspace/image.png", data }];

      const result = await adapter.writeBinaryFiles(files);

      expect(result.succeeded.length).toBe(1);
      expect(mockWritable.write).toHaveBeenCalledWith(data);
      expect(mockWritable.close).toHaveBeenCalled();
    });

    it("should handle empty binary files", async () => {
      const files = [
        { path: "/test-workspace/empty.bin", data: new Uint8Array() },
      ];

      const result = await adapter.writeBinaryFiles(files);

      expect(result.succeeded.length).toBe(1);
      expect(mockWritable.write).toHaveBeenCalledWith(new Uint8Array());
    });

    it("should return failed array for errors", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockRejectedValue(new Error("Permission denied"));

      const files = [
        { path: "/test-workspace/file.bin", data: new Uint8Array([1]) },
      ];

      const result = await adapter.writeBinaryFiles(files);

      expect(result.succeeded.length).toBe(0);
      expect(result.failed.length).toBe(1);
    });
  });

  describe("resolveAssetUrl", () => {
    it("should create blob URL for binary files", async () => {
      const result = await adapter.resolveAssetUrl(
        "image.png",
        "/test-workspace",
      );

      expect(result).toBe("blob:mock-url");
      expect(URL.createObjectURL).toHaveBeenCalled();
    });

    it("should return relative path for text files when file not found", async () => {
      mockDirectoryHandle.getFileHandle = vi
        .fn()
        .mockRejectedValue(new Error("Not found"));

      const result = await adapter.resolveAssetUrl(
        "missing.png",
        "/test-workspace",
      );

      expect(result).toBe("missing.png");
    });

    it("should handle absolute paths", async () => {
      const result = await adapter.resolveAssetUrl(
        "/test-workspace/image.png",
        "/other-workspace",
      );

      expect(result).toBe("blob:mock-url");
    });
  });

  describe("file watching", () => {
    it("should start watching metadata", async () => {
      await adapter.startWatchingMetadata(["/test-workspace"], "watch-1");

      expect(fileWatcherMock.startWatchingMetadata).toHaveBeenCalledWith(
        ["/test-workspace"],
        "watch-1",
      );
    });

    it("should start watching content", async () => {
      await adapter.startWatchingContent(
        ["/test-workspace/file.txt"],
        "watch-2",
      );

      expect(fileWatcherMock.startWatchingContent).toHaveBeenCalledWith(
        ["/test-workspace/file.txt"],
        "watch-2",
      );
    });

    it("should stop watching by watchId", async () => {
      await adapter.stopWatching("watch-1");

      expect(fileWatcherMock.stopWatching).toHaveBeenCalledWith("watch-1");
    });
  });

  describe("event listeners", () => {
    it("should register callback for events", () => {
      const callback = vi.fn();

      const unsubscribe = adapter.addEventListener(callback);

      expect(fileWatcherMock.addEventListener).toHaveBeenCalledWith(callback);
      expect(typeof unsubscribe).toBe("function");
    });

    it("should return unsubscribe function", () => {
      const callback = vi.fn();

      const unsubscribe = adapter.addEventListener(callback);
      unsubscribe();

      expect(fileWatcherMock.removeEventListener).toHaveBeenCalledWith(
        callback,
      );
    });

    it("should support multiple listeners", () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      adapter.addEventListener(callback1);
      adapter.addEventListener(callback2);

      expect(fileWatcherMock.addEventListener).toHaveBeenCalledTimes(2);
    });
  });
});

describe("shouldUseBrowserFsAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (global as any).window = {
      showDirectoryPicker: vi.fn(),
      __VITE_INDEXEDDB_NAME__: undefined,
    };
    Object.defineProperty(navigator, "webdriver", {
      value: undefined,
      configurable: true,
    });
  });

  it("should return false in E2E test environment", () => {
    (window as any).__VITE_INDEXEDDB_NAME__ = "test-db";

    expect(shouldUseBrowserFsAdapter()).toBe(false);

    delete (window as any).__VITE_INDEXEDDB_NAME__;
  });

  it("should return false in automated browser", () => {
    Object.defineProperty(navigator, "webdriver", {
      value: true,
      configurable: true,
    });

    expect(shouldUseBrowserFsAdapter()).toBe(false);
  });

  it("should return true when File System Access API is supported", () => {
    (window as any).showDirectoryPicker = vi.fn();

    expect(shouldUseBrowserFsAdapter()).toBe(true);
  });

  it("should return false when File System Access API is not supported", () => {
    delete (window as any).showDirectoryPicker;

    expect(shouldUseBrowserFsAdapter()).toBe(false);
  });
});
