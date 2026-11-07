import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { defineModule, type Core } from "@notefig/core";
import { CoreProvider } from "@notefig/core/react";
import { SettingsModal } from "../settings-modal";
import { ThemeProvider } from "../../theme-provider";
import { createTestCore, memoryUrlState } from "@/testing/test-core";
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

vi.mock("@/components/sync/sync-settings", () => ({
  SyncSettings: () => null,
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

function createSettingsCore(initialSearch: string) {
  return createTestCore({
    url: memoryUrlState(initialSearch),
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
}

beforeEach(() => {
  testCore = createSettingsCore("");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = "";
});

function renderWithSettingsModal(initialSearch = "") {
  // The app's URL state is core's `url`, not the router's.
  testCore = createSettingsCore(initialSearch);
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
  return testCore.use("url").search().replace(/^\?/, "");
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
