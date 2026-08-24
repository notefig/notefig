import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Titlebar } from "@/components/titlebar";

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
