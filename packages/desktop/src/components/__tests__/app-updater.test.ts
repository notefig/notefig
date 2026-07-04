import { describe, it, expect } from "vitest";
import {
  deriveUpdaterView,
  type InstallState,
  type UpdateCheckData,
} from "@/components/app-updater";

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
    expect(deriveUpdaterView(check({ data: upToDate }), idleInstall).status).toBe(
      "up-to-date",
    );
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

  it("defaults the flow to download-restart before any check", () => {
    expect(deriveUpdaterView(check(), idleInstall).flow).toBe(
      "download-restart",
    );
  });
});
