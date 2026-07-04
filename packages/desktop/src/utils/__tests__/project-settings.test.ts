import { describe, it, expect, vi, beforeEach } from "vitest";
import { platformAdapter } from "@/adapters";
import {
  readProjectSettings,
  updateProjectSettings,
  projectSettingsPath,
  resolveProjectSettings,
  DEFAULT_PROJECT_SETTINGS,
} from "../project-settings";

vi.mock("@/adapters", () => ({
  platformAdapter: {
    readFiles: vi.fn(),
    writeFiles: vi.fn(),
  },
}));

const readMock = vi.mocked(platformAdapter.readFiles);
const writeMock = vi.mocked(platformAdapter.writeFiles);

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
    expect(
      resolveProjectSettings({ settings: { direction: "rtl" } }),
    ).toEqual({ ...DEFAULT_PROJECT_SETTINGS, direction: "rtl" });
  });
});

describe("readProjectSettings", () => {
  it("returns {} when the file is missing", async () => {
    mockMissingFile();
    expect(await readProjectSettings(WORKSPACE)).toEqual({});
  });

  it("returns {} for invalid JSON", async () => {
    mockFileContent("{not json");
    expect(await readProjectSettings(WORKSPACE)).toEqual({});
  });

  it("returns {} for non-object JSON", async () => {
    mockFileContent('"just a string"');
    expect(await readProjectSettings(WORKSPACE)).toEqual({});
  });

  it("parses valid settings", async () => {
    mockFileContent('{"settings":{"direction":"rtl"}}');
    expect(await readProjectSettings(WORKSPACE)).toEqual({
      settings: { direction: "rtl" },
    });
  });
});

describe("updateProjectSettings", () => {
  it("creates the file from scratch when missing", async () => {
    mockMissingFile();
    await updateProjectSettings(WORKSPACE, {
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

    await updateProjectSettings(WORKSPACE, {
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
      updateProjectSettings(WORKSPACE, { settings: { direction: "rtl" } }),
    ).rejects.toThrow("disk full");
  });
});
