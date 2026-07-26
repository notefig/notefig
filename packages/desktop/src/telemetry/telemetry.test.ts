import { beforeEach, describe, expect, it, vi } from "vitest";

const capture = vi.fn();
const captureException = vi.fn();
const init = vi.fn();
const register = vi.fn();

vi.mock("posthog-js", () => ({
  default: { init, capture, captureException, register },
}));

async function loadTelemetry(withKey: boolean) {
  vi.resetModules();
  if (withKey) {
    vi.stubEnv("VITE_POSTHOG_KEY", "phc_test");
  } else {
    vi.stubEnv("VITE_POSTHOG_KEY", "");
  }
  const mod = await import("./telemetry");
  mod.__resetTelemetryForTests();
  return mod;
}

beforeEach(() => {
  vi.unstubAllEnvs();
  capture.mockClear();
  captureException.mockClear();
  init.mockClear();
  register.mockClear();
});

describe("telemetry buffering and tiers", () => {
  it("buffers pre-consent events and flushes enabled tiers on configure", async () => {
    const t = await loadTelemetry(true);
    t.captureEvent("workspace_opened", { is_new: false });
    t.captureError(new Error("boom"));
    expect(capture).not.toHaveBeenCalled();

    await t.configureTelemetry({
      crashEnabled: true,
      analyticsEnabled: true,
      installId: "id-1",
    });

    expect(init).toHaveBeenCalledOnce();
    expect(capture).toHaveBeenCalledWith("workspace_opened", {
      is_new: false,
    });
    expect(captureException).toHaveBeenCalledOnce();
  });

  it("registers app_version and platform as super properties on init", async () => {
    const t = await loadTelemetry(true);
    await t.configureTelemetry({
      crashEnabled: true,
      analyticsEnabled: true,
      installId: "id-1",
    });

    expect(register).toHaveBeenCalledWith({
      app_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      platform: expect.any(String),
    });
  });

  it("drops buffered usage events when analytics is declined", async () => {
    const t = await loadTelemetry(true);
    t.captureEvent("workspace_opened", { is_new: true });
    t.captureError(new Error("boom"));

    await t.configureTelemetry({
      crashEnabled: true,
      analyticsEnabled: false,
      installId: "id-1",
    });

    expect(capture).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledOnce();
  });

  it("sends nothing and never inits when both tiers are off", async () => {
    const t = await loadTelemetry(true);
    t.captureError(new Error("boom"));
    await t.configureTelemetry({
      crashEnabled: false,
      analyticsEnabled: false,
      installId: null,
    });
    t.captureEvent("workspace_opened", { is_new: true });

    expect(init).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("is fully inert without a build-time key", async () => {
    const t = await loadTelemetry(false);
    expect(t.telemetryAvailable()).toBe(false);
    t.captureError(new Error("boom"));
    await t.configureTelemetry({
      crashEnabled: true,
      analyticsEnabled: true,
      installId: "id-1",
    });
    t.captureEvent("workspace_opened", { is_new: true });

    expect(init).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("caps the pending buffer", async () => {
    const t = await loadTelemetry(true);
    for (let i = 0; i < 40; i++) {
      t.captureEvent("settings_changed", { setting: `s${i}` });
    }
    await t.configureTelemetry({
      crashEnabled: false,
      analyticsEnabled: true,
      installId: "id-1",
    });
    expect(capture.mock.calls.length).toBeLessThanOrEqual(25);
  });

  it("routes telemetry_consent_answered when only crash is enabled", async () => {
    const t = await loadTelemetry(true);
    await t.configureTelemetry({
      crashEnabled: true,
      analyticsEnabled: false,
      installId: "id-1",
    });
    t.captureEvent("telemetry_consent_answered", {
      crash_enabled: true,
      analytics_enabled: false,
    });
    expect(capture).toHaveBeenCalledWith("telemetry_consent_answered", {
      crash_enabled: true,
      analytics_enabled: false,
    });
  });

  it("stops usage events after a live opt-out", async () => {
    const t = await loadTelemetry(true);
    await t.configureTelemetry({
      crashEnabled: true,
      analyticsEnabled: true,
      installId: "id-1",
    });
    t.captureEvent("workspace_opened", { is_new: false });
    expect(capture).toHaveBeenCalledTimes(1);

    await t.updateTelemetryConsent({
      crashEnabled: true,
      analyticsEnabled: false,
      installId: "id-1",
    });
    t.captureEvent("workspace_opened", { is_new: false });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("dedupes identical errors within the dedupe window", async () => {
    const t = await loadTelemetry(true);
    await t.configureTelemetry({
      crashEnabled: true,
      analyticsEnabled: false,
      installId: "id-1",
    });
    t.captureError(new Error("same message"));
    t.captureError(new Error("same message"));
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
