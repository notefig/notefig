import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  createProjectSettings,
  projectSettingsPath,
  resolveProjectSettings,
  DEFAULT_PROJECT_SETTINGS,
  type ProjectSettingsApi,
} from "../project-settings";

const readMock = vi.fn<ProjectSettingsFs["readFiles"]>();
const writeMock = vi.fn<ProjectSettingsFs["writeFiles"]>();
type ProjectSettingsFs = Parameters<typeof createProjectSettings>[0]["fs"];

let projectSettings: ProjectSettingsApi;

const WORKSPACE = "/workspace";
const SETTINGS_PATH = projectSettingsPath(WORKSPACE);

function mockFileContent(content: string) {
  readMock.mockResolvedValue({
    succeeded: [{ path: SETTINGS_PATH, content }],
    failed: [],
  });
}

function mockMissingFile() {
  readMock.mockResolvedValue({
    succeeded: [],
    failed: [
      { path: SETTINGS_PATH, message: "Not found", code: "NotFound" },
    ] as never[],
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  writeMock.mockResolvedValue({ succeeded: [SETTINGS_PATH], failed: [] });
  projectSettings = createProjectSettings({
    fs: { readFiles: readMock, writeFiles: writeMock },
    queryClient: new QueryClient(),
  });
});

describe("projectSettingsPath", () => {
  it("points at metrists.json in the workspace root", () => {
    expect(SETTINGS_PATH).toBe("/workspace/metrists.json");
  });
});

describe("resolveProjectSettings", () => {
  it("returns defaults for an empty file", () => {
    expect(resolveProjectSettings({})).toEqual(DEFAULT_PROJECT_SETTINGS);
  });

  it("overlays file values onto defaults", () => {
    expect(resolveProjectSettings({ settings: { direction: "rtl" } })).toEqual({
      ...DEFAULT_PROJECT_SETTINGS,
      direction: "rtl",
    });
  });
});

describe("read", () => {
  it("returns {} when the file is missing", async () => {
    mockMissingFile();
    expect(await projectSettings.read(WORKSPACE)).toEqual({});
  });

  it("returns {} for invalid JSON", async () => {
    mockFileContent("{not json");
    expect(await projectSettings.read(WORKSPACE)).toEqual({});
  });

  it("returns {} for non-object JSON", async () => {
    mockFileContent('"just a string"');
    expect(await projectSettings.read(WORKSPACE)).toEqual({});
  });

  it("parses valid settings", async () => {
    mockFileContent('{"settings":{"direction":"rtl"}}');
    expect(await projectSettings.read(WORKSPACE)).toEqual({
      settings: { direction: "rtl" },
    });
  });
});

describe("update", () => {
  it("creates the file from scratch when missing", async () => {
    mockMissingFile();
    await projectSettings.update(WORKSPACE, {
      settings: { direction: "rtl" },
    });

    expect(writeMock).toHaveBeenCalledTimes(1);
    const [files] = writeMock.mock.calls[0];
    expect(files[0].path).toBe(SETTINGS_PATH);
    expect(JSON.parse(files[0].content)).toEqual({
      settings: { direction: "rtl" },
    });
  });

  it("shallow-merges sections and preserves unknown keys", async () => {
    mockFileContent(
      JSON.stringify({
        workspace: { name: "My Book" },
        settings: { direction: "ltr", fontSize: 14 },
        unknownTopLevel: true,
      }),
    );

    await projectSettings.update(WORKSPACE, {
      settings: { direction: "rtl" },
    });

    const [files] = writeMock.mock.calls[0];
    expect(JSON.parse(files[0].content)).toEqual({
      workspace: { name: "My Book" },
      settings: { direction: "rtl", fontSize: 14 },
      unknownTopLevel: true,
    });
  });

  it("throws when the write fails", async () => {
    mockMissingFile();
    writeMock.mockResolvedValue({
      succeeded: [],
      failed: [
        { path: SETTINGS_PATH, message: "disk full", code: "Io" },
      ] as never[],
    });

    await expect(
      projectSettings.update(WORKSPACE, { settings: { direction: "rtl" } }),
    ).rejects.toThrow("disk full");
  });
});
