import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import {
  Titlebar,
  trafficLightsClearance,
  trafficLightsInsetStart,
} from "@/components/titlebar";
// Initializes the shared i18n instance so t() resolves the English strings.
import "@/utils/intl";

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-app-settings", () => ({
  useAppSettings: () => ({ settings: { zoomLevel: 1 } }),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as Record<string, unknown>).__NOTEFIG_DESKTOP_OS__;
});

function renderOn(os: "macos" | "windows" | "linux") {
  (window as unknown as Record<string, unknown>).__NOTEFIG_DESKTOP_OS__ = os;
  act(() => {
    root.render(createElement(Titlebar));
  });
}

describe("Titlebar", () => {
  it("renders window control buttons on windows", () => {
    renderOn("windows");
    expect(container.querySelector('[aria-label="Minimize"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Maximize"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Close"]')).not.toBeNull();
  });

  it("renders only a drag-region spacer on macos, no window control buttons", () => {
    renderOn("macos");
    expect(container.querySelector("[data-tauri-drag-region]")).not.toBeNull();
    expect(container.querySelector('[aria-label="Close"]')).toBeNull();
  });

  it("renders nothing on linux", () => {
    renderOn("linux");
    expect(container.innerHTML).toBe("");
  });
});

describe("traffic-light geometry", () => {
  // macOS 15: three 12pt glyphs on 20pt centres, close at x=23.
  const sequoia = { left: 23, right: 75, top: 24.5, bottom: 36.5 };
  // macOS 26: 14pt glyphs on 23pt centres from the same origin — a wider
  // cluster the header's start padding has to clear.
  const tahoe = { left: 23, right: 83, top: 24, bottom: 38 };

  it("clears the measured cluster, not the macOS 15 constant", () => {
    expect(trafficLightsInsetStart(sequoia, 1)).toBe(74);
    expect(trafficLightsInsetStart(tahoe, 1)).toBe(82);
  });

  it("divides the physical-pixel budget by the webview zoom", () => {
    expect(trafficLightsInsetStart(tahoe, 1.5)).toBe(Math.ceil(82 / 1.5));
    expect(trafficLightsClearance(tahoe, 1.5)).toBe(Math.ceil(42 / 1.5));
  });

  it("keeps a content-less spacer under the lowest glyph edge", () => {
    expect(trafficLightsClearance(sequoia, 1)).toBe(41);
    expect(trafficLightsClearance(tahoe, 1)).toBe(42);
  });
});
