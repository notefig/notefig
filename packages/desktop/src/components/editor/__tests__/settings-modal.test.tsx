import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defineModule, type Core } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import { SettingsModal } from "../settings-modal";
import { ThemeProvider } from "../../theme-provider";
import { createTestCore } from "@/testing/test-core";
import { kvModule } from "@/modules/kv";
import { workspacesModule } from "@/modules/workspaces";
import { createFeedback } from "@/modules/feedback";
import "@/utils/intl";

vi.mock("@/components/agent/harness-settings", () => ({
  HarnessSettings: () => null,
}));

vi.mock("@/components/agent/usage-settings", () => ({
  UsageSettings: () => null,
}));

vi.mock("@/components/app-updater", () => ({
  useAppUpdater: () => ({
    status: "idle",
    progress: { downloaded: 0, total: null },
    error: null,
    flow: "download",
    checkForUpdate: vi.fn(),
  }),
  relaunchApp: vi.fn(),
  startDownloadWithToastPromise: vi.fn(),
}));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let testCore: Core;
let container: HTMLDivElement | null = null;
let root: Root | null = null;

function SearchParamsReader() {
  const [searchParams] = useSearchParams();
  return (
    <div data-testid="search-params" className="sr-only">
      {searchParams.toString()}
    </div>
  );
}

beforeEach(() => {
  testCore = createTestCore({
    modules: [
      kvModule,
      workspacesModule,
      defineModule({
        name: "feedback",
        register: () =>
          createFeedback({ supportUrl: "https://support.notefig.com" }),
      }),
    ],
  });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

function renderWithSettingsModal(initialSearch = "") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  act(() => {
    root!.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          MemoryRouter,
          { initialEntries: [`/${initialSearch}`] },
          createElement(ThemeProvider, {
            defaultTheme: "light",
            children: createElement(CoreProvider, {
              core: testCore,
              children: createElement(
                "div",
                null,
                createElement(SearchParamsReader, null),
                createElement(SettingsModal, {
                  direction: "ltr",
                  onDirectionChange: () => {},
                  onFocusTab: () => true,
                }),
              ),
            }),
          }),
        ),
      ),
    );
  });
}

function currentParams(): string {
  return (
    container?.querySelector("[data-testid='search-params']")?.textContent ?? ""
  );
}

describe("SettingsModal shortcuts", () => {
  it("opens the Usage section on Cmd/Ctrl+Shift+U while keeping existing params", async () => {
    renderWithSettingsModal("?sidebar=collapsed");

    document.body.focus();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "u",
          code: "KeyU",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });

    expect(currentParams()).toContain("sidebar=collapsed");
    expect(currentParams()).toContain("settings=usage");
  });

  it("still opens Usage when no other params are present", async () => {
    renderWithSettingsModal("");

    document.body.focus();
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "u",
          code: "KeyU",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        }),
      );
    });

    expect(currentParams()).toBe("settings=usage");
  });
});
