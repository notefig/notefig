import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider, type Theme } from "./theme-provider";

type Listener = () => void;

/** A prefers-color-scheme query the test can flip, like the OS would. */
function fakeColorScheme(initiallyDark: boolean) {
  const listeners = new Set<Listener>();
  const query = {
    matches: initiallyDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_: "change", listener: Listener) =>
      listeners.add(listener),
    removeEventListener: (_: "change", listener: Listener) =>
      listeners.delete(listener),
  };
  return {
    matchMedia: () => query,
    listenerCount: () => listeners.size,
    setDark(dark: boolean) {
      query.matches = dark;
      for (const listener of listeners) listener();
    },
  };
}

function rootTheme(): string | null {
  const { classList } = document.documentElement;
  if (classList.contains("dark")) return "dark";
  if (classList.contains("light")) return "light";
  return null;
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("ThemeProvider", () => {
  let scheme: ReturnType<typeof fakeColorScheme>;

  beforeEach(() => {
    scheme = fakeColorScheme(false);
    vi.spyOn(window, "matchMedia").mockImplementation(
      scheme.matchMedia as unknown as typeof window.matchMedia,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.classList.remove("light", "dark");
  });

  const renderWith = (theme: Theme) => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        createElement(ThemeProvider, { defaultTheme: theme, children: null }),
      ),
    );
    return { unmount: () => act(() => root.unmount()) };
  };

  it("follows the OS appearance live while on system", () => {
    renderWith("system");
    expect(rootTheme()).toBe("light");

    act(() => scheme.setDark(true));
    expect(rootTheme()).toBe("dark");

    act(() => scheme.setDark(false));
    expect(rootTheme()).toBe("light");
  });

  it("ignores OS changes on an explicit theme", () => {
    renderWith("light");
    expect(scheme.listenerCount()).toBe(0);

    act(() => scheme.setDark(true));
    expect(rootTheme()).toBe("light");
  });

  it("stops listening when unmounted", () => {
    const { unmount } = renderWith("system");
    expect(scheme.listenerCount()).toBe(1);
    unmount();
    expect(scheme.listenerCount()).toBe(0);
  });
});
