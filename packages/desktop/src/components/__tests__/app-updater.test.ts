import { beforeEach, describe, it, expect, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  deriveUpdaterView,
  downloadAndInstall,
  relaunchApp,
  resolveUpdateNotification,
  UPDATE_CHECK_QUERY_KEY,
  type InstallState,
  type UpdateCheckData,
} from "@/components/app-updater";

const mockCaptureEvent = vi.fn();
vi.mock("@/telemetry/telemetry", () => ({
  captureEvent: (...args: unknown[]) => mockCaptureEvent(...args),
}));

const mockUpdater = {
  check: vi.fn(),
  apply: vi.fn(),
  restart: vi.fn(),
};
// A getter, not a plain property: vi.mock is hoisted above `mockUpdater`'s
// declaration, so reading it eagerly here would hit the TDZ. The old
// `getUpdater()` method deferred the read for free; this keeps that.
vi.mock("@/adapters", () => ({
  platformAdapter: {
    get updates() {
      return mockUpdater;
    },
  },
}));

const idleInstall: InstallState = {
  phase: "idle",
  progress: { downloaded: 0, total: null },
  error: null,
};

const available: UpdateCheckData = {
  flow: "download-restart",
  updateInfo: { version: "1.2.3", body: "notes" },
};

const upToDate: UpdateCheckData = {
  flow: "download-restart",
  updateInfo: null,
};

function check(
  overrides: Partial<Parameters<typeof deriveUpdaterView>[0]> = {},
) {
  return { data: undefined, isFetching: false, isError: false, ...overrides };
}

describe("deriveUpdaterView", () => {
  it("is idle before any check has run", () => {
    expect(deriveUpdaterView(check(), idleInstall).status).toBe("idle");
  });

  it("is checking while a check is in flight", () => {
    expect(
      deriveUpdaterView(check({ isFetching: true }), idleInstall).status,
    ).toBe("checking");
  });

  it("reports an available update with its info and flow", () => {
    const view = deriveUpdaterView(check({ data: available }), idleInstall);
    expect(view.status).toBe("available");
    expect(view.updateInfo).toEqual({ version: "1.2.3", body: "notes" });
    expect(view.flow).toBe("download-restart");
  });

  it("is up-to-date when the check returned no update", () => {
    expect(
      deriveUpdaterView(check({ data: upToDate }), idleInstall).status,
    ).toBe("up-to-date");
  });

  it("surfaces check failures as an error with a message", () => {
    const view = deriveUpdaterView(check({ isError: true }), idleInstall);
    expect(view.status).toBe("error");
    expect(view.error).toBeTruthy();
  });

  it("a downloading install wins over concurrent check activity", () => {
    const view = deriveUpdaterView(
      check({ data: available, isFetching: true }),
      {
        phase: "downloading",
        progress: { downloaded: 50, total: 100 },
        error: null,
      },
    );
    expect(view.status).toBe("downloading");
    expect(view.progress).toEqual({ downloaded: 50, total: 100 });
  });

  it("a staged (ready) install wins over check results", () => {
    const view = deriveUpdaterView(check({ data: available }), {
      ...idleInstall,
      phase: "ready",
    });
    expect(view.status).toBe("ready");
  });

  it("an install error wins and carries the install's message", () => {
    const view = deriveUpdaterView(check({ data: available }), {
      ...idleInstall,
      phase: "error",
      error: "download failed",
    });
    expect(view.status).toBe("error");
    expect(view.error).toBe("download failed");
  });
});

describe("resolveUpdateNotification", () => {
  const base = {
    autoUpdateEnabled: true,
    settingsReady: true,
    flow: "download-restart" as const,
    installActive: false,
  };

  it("auto-downloads when the setting is on for the download-restart flow", () => {
    expect(resolveUpdateNotification(base)).toBe("auto-download");
  });

  it("prompts when the setting is off", () => {
    expect(
      resolveUpdateNotification({ ...base, autoUpdateEnabled: false }),
    ).toBe("prompt");
  });

  it("prompts for the refresh flow even with the setting on", () => {
    expect(resolveUpdateNotification({ ...base, flow: "refresh" })).toBe(
      "prompt",
    );
  });

  it("defers until settings have loaded", () => {
    expect(resolveUpdateNotification({ ...base, settingsReady: false })).toBe(
      "none",
    );
  });

  it("defers while an install is already in flight", () => {
    expect(resolveUpdateNotification({ ...base, installActive: true })).toBe(
      "none",
    );
  });
});

describe("update telemetry", () => {
  beforeEach(() => {
    mockCaptureEvent.mockClear();
    mockUpdater.apply.mockReset();
    mockUpdater.restart.mockReset();
  });

  function clientWithAvailableUpdate(): QueryClient {
    const queryClient = new QueryClient();
    queryClient.setQueryData(UPDATE_CHECK_QUERY_KEY, available);
    return queryClient;
  }

  it("captures started and completed on a successful download", async () => {
    mockUpdater.apply.mockReturnValue(
      (async function* () {
        yield { status: "downloading", downloaded: 10, total: 100 };
        yield { status: "ready" };
      })(),
    );

    await downloadAndInstall(clientWithAvailableUpdate());

    expect(mockCaptureEvent).toHaveBeenCalledWith("update_download_started", {
      to_version: "1.2.3",
      trigger: "manual",
    });
    expect(mockCaptureEvent).toHaveBeenCalledWith("update_download_completed", {
      to_version: "1.2.3",
    });
  });

  it("tags auto-triggered downloads in telemetry", async () => {
    mockUpdater.apply.mockReturnValue(
      (async function* () {
        yield { status: "ready" };
      })(),
    );

    await downloadAndInstall(clientWithAvailableUpdate(), "auto");

    expect(mockCaptureEvent).toHaveBeenCalledWith("update_download_started", {
      to_version: "1.2.3",
      trigger: "auto",
    });
  });

  it("captures update_failed (stage download) when the download errors", async () => {
    mockUpdater.apply.mockReturnValue(
      (async function* () {
        yield { status: "error" };
      })(),
    );

    await expect(
      downloadAndInstall(clientWithAvailableUpdate()),
    ).rejects.toThrow();

    expect(mockCaptureEvent).toHaveBeenCalledWith("update_failed", {
      stage: "download",
      to_version: "1.2.3",
    });
    expect(mockCaptureEvent).not.toHaveBeenCalledWith(
      "update_download_completed",
      expect.anything(),
    );
  });

  it("captures update_failed (stage restart) when relaunch errors", async () => {
    mockUpdater.restart.mockResolvedValue({ status: "error" });

    await relaunchApp(clientWithAvailableUpdate());

    expect(mockCaptureEvent).toHaveBeenCalledWith("update_failed", {
      stage: "restart",
      to_version: "1.2.3",
    });
  });

  it("falls back to an unknown target version when no check data exists", async () => {
    mockUpdater.restart.mockResolvedValue({ status: "error" });

    await relaunchApp(new QueryClient());

    expect(mockCaptureEvent).toHaveBeenCalledWith("update_failed", {
      stage: "restart",
      to_version: "unknown",
    });
  });
});
