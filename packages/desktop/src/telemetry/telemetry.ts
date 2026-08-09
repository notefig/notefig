import { scrubEvent, scrubString } from "./scrub";
import type { TelemetryEvent } from "./events";
import { isWeb } from "@/utils/platform";

/**
 * Telemetry singleton. No PostHog code runs until consent is resolved:
 * events buffer in memory while state is "pending", then flush through the
 * tier filter once configureTelemetry() runs (first-run dialog answered, or
 * stored flags hydrated on later launches). posthog-js is dynamically
 * imported only when a tier is enabled AND a key is present, so opted-out
 * users and keyless (dev/fork) builds never load it. See TELEMETRY.md.
 */

export const TELEMETRY_KEY: string | undefined = import.meta.env
  .VITE_POSTHOG_KEY;
const TELEMETRY_HOST: string =
  import.meta.env.VITE_POSTHOG_HOST ?? "https://us.i.posthog.com";

const BUFFER_CAP = 25;
const ERROR_DEDUPE_WINDOW_MS = 5_000;

// "meta" = telemetry-about-telemetry (the consent answer): sent when ANY
// tier is enabled, since it's needed to reason about both populations.
type Tier = "usage" | "crash" | "meta";

interface BufferedItem {
  tier: Tier;
  send: (posthog: PostHogLike) => void;
}

interface PostHogLike {
  capture: (name: string, properties?: Record<string, unknown>) => void;
  captureException: (
    error: unknown,
    properties?: Record<string, unknown>,
  ) => void;
  register: (properties: Record<string, unknown>) => void;
}

interface TelemetryConsent {
  crashEnabled: boolean;
  analyticsEnabled: boolean;
}

let state: "pending" | "configured" = "pending";
let consent: TelemetryConsent = {
  crashEnabled: false,
  analyticsEnabled: false,
};
let posthogInstance: PostHogLike | null = null;
let posthogLoad: Promise<PostHogLike | null> | null = null;
let buffer: BufferedItem[] = [];
const recentErrors = new Map<string, number>();

export function telemetryAvailable(): boolean {
  // Test-backend (e2e shim) runs are never telemetry-eligible, even when
  // the dev server carries a real key via .env.
  return Boolean(TELEMETRY_KEY) && !import.meta.env.VITE_TEST_BACKEND;
}

function tierEnabled(tier: Tier): boolean {
  if (tier === "crash") return consent.crashEnabled;
  if (tier === "meta") return consent.crashEnabled || consent.analyticsEnabled;
  return consent.analyticsEnabled;
}

function coarsePlatform(): string {
  if (isWeb()) return "web";
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) return "macos";
  if (platform.includes("win")) return "windows";
  return "linux";
}

function loadPosthog(installId: string): Promise<PostHogLike | null> {
  if (!posthogLoad) {
    posthogLoad = import("posthog-js")
      .then(({ default: posthog }) => {
        posthog.init(TELEMETRY_KEY as string, {
          api_host: TELEMETRY_HOST,
          autocapture: false,
          capture_pageview: false,
          capture_pageleave: false,
          disable_session_recording: true,
          disable_surveys: true,
          persistence: "memory",
          bootstrap: { distinctID: installId },
          before_send: scrubEvent,
        });
        // Super properties: stamped on every event, including $exception —
        // per-event properties can't cover autocaptured errors.
        posthog.register({
          app_version: __APP_VERSION__,
          platform: coarsePlatform(),
        });
        return posthog as unknown as PostHogLike;
      })
      .catch((error) => {
        console.error("[telemetry] failed to load posthog-js:", error);
        return null;
      });
  }
  return posthogLoad;
}

function dispatch(item: BufferedItem) {
  if (state === "pending") {
    buffer.push(item);
    if (buffer.length > BUFFER_CAP) buffer.shift();
    return;
  }
  if (!tierEnabled(item.tier) || !posthogInstance) return;
  item.send(posthogInstance);
}

/**
 * Resolve consent and (if anything is enabled) start PostHog, then flush
 * the pending buffer through the tier filter. Safe to call again from the
 * Settings toggles via updateTelemetryConsent.
 */
export async function configureTelemetry(
  options: TelemetryConsent & { installId: string | null },
): Promise<void> {
  consent = {
    crashEnabled: options.crashEnabled,
    analyticsEnabled: options.analyticsEnabled,
  };
  const anyEnabled = consent.crashEnabled || consent.analyticsEnabled;

  if (anyEnabled && telemetryAvailable() && options.installId) {
    posthogInstance = await loadPosthog(options.installId);
  }

  state = "configured";
  const pending = buffer;
  buffer = [];
  for (const item of pending) {
    dispatch(item);
  }
}

/** Live consent changes from the Settings toggles. */
export async function updateTelemetryConsent(
  options: TelemetryConsent & { installId: string | null },
): Promise<void> {
  await configureTelemetry(options);
}

/** Usage-tier event (Tier 2). Buffered while pending, dropped when opted out. */
export function captureEvent<E extends TelemetryEvent>(
  name: E["name"],
  properties?: E["properties"],
): void {
  dispatch({
    tier: name === "telemetry_consent_answered" ? "meta" : "usage",
    send: (posthog) =>
      posthog.capture(name, properties as Record<string, unknown> | undefined),
  });
}

/** Crash-tier exception (Tier 1). Buffered while pending, dropped when opted out. */
export function captureError(
  error: unknown,
  context?: Record<string, string | number | boolean>,
): void {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const now = Date.now();
  const lastSeen = recentErrors.get(message);
  if (lastSeen !== undefined && now - lastSeen < ERROR_DEDUPE_WINDOW_MS) return;
  recentErrors.set(message, now);

  dispatch({
    tier: "crash",
    send: (posthog) => posthog.captureException(error, context),
  });
}

/**
 * Register window-level capture points immediately at app start, so
 * pre-consent errors land in the buffer.
 */
export function initGlobalErrorHandlers(): void {
  window.addEventListener("error", (event) => {
    captureError(event.error ?? event.message, { boundary: "window" });
  });
  window.addEventListener("unhandledrejection", (event) => {
    captureError(event.reason, { boundary: "unhandledrejection" });
  });
}

/** Test-only: reset module state between vitest cases. */
export function __resetTelemetryForTests(): void {
  state = "pending";
  consent = { crashEnabled: false, analyticsEnabled: false };
  posthogInstance = null;
  posthogLoad = null;
  buffer = [];
  recentErrors.clear();
}

/** Test-only: inject a fake PostHog client without dynamic import. */
export function __setPosthogForTests(instance: PostHogLike | null): void {
  posthogInstance = instance;
}

export { scrubString };
