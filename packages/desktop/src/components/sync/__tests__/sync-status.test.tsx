import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoreProvider } from "@notefig/core/react";
import "@/utils/intl";
import { createTestCore } from "@/testing/test-core";
import type { CredentialStatus, CredentialsSurface } from "@/adapters/platform-adapter.interface";
import { INITIAL_SYNC_STATE, type SyncState, type WorkspaceSync } from "@/modules/sync";
import { SyncPanel } from "../sync-status";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const remote = { url: "https://github.com/team/notes.git", branch: "main" };
const ada: CredentialStatus = { source: "git", username: "ada" };

function fakeSync(): WorkspaceSync {
  return {
    turnOn: vi.fn(async () => {}),
    decline: vi.fn(async () => {}),
    turnOffForEveryone: vi.fn(async () => {}),
    resume: vi.fn(),
    dismissOverwritten: vi.fn(),
    syncNow: vi.fn(async () => {}),
  } as unknown as WorkspaceSync;
}

async function render(state: Partial<SyncState>, credential: CredentialStatus | null = ada) {
  const credentials: CredentialsSurface = {
    supported: true,
    status: vi.fn(async () => credential),
    set: vi.fn(async () => ({ source: "stored", username: "x-access-token" }) as const),
    delete: vi.fn(async () => ada),
  };
  const core = createTestCore({ platform: { credentials } });
  const sync = fakeSync();
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(CoreProvider, {
          core,
          children: createElement(SyncPanel, { sync, state: { ...INITIAL_SYNC_STATE, remote, ...state } }),
        }),
      ),
    ),
  );
  // The credential query resolves.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return { sync, credentials, text: () => host.textContent ?? "" };
}

const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const click = (label: string) => act(async () => button(label).click());

describe("the sync popover", () => {
  it("lists what a merge overwrote until dismissed", async () => {
    const { sync, text } = await render({ setup: "on", overwritten: [{ path: "a.md", text: "Mine." }] });
    expect(text()).toContain("A newer edit replaced this text of yours:");
    expect(text()).toContain("Mine.");
    await click("Dismiss");
    expect(sync.dismissOverwritten).toHaveBeenCalled();
  });

  it("offers to turn on a project, naming the remote and the credential, and shows what to fix", async () => {
    const { sync, text } = await render({ setup: "off" });
    expect(text()).toContain("github.com/team/notes · main");
    expect(text()).toContain("Everyone who opens the project is asked");
    expect(text()).toContain("Using your git credentials (ada).");

    vi.mocked(sync.turnOn).mockRejectedValueOnce(new Error("These credentials can't push."));
    await click("Turn on sync");
    expect(sync.turnOn).toHaveBeenCalled();
    expect(text()).toContain("These credentials can't push.");
  });

  it("asks this device, and saying no keeps a local copy", async () => {
    const { sync, text } = await render({ setup: "ask" });
    expect(text()).toContain("Sync it on this device?");
    await click("Not now");
    expect(sync.decline).toHaveBeenCalled();
  });

  it("switches to a pasted token in place, without asking Rust again", async () => {
    const { credentials, text } = await render({ setup: "on" });
    await click("Use a token instead");
    const input = document.querySelector("input")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "ghp_x");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save");

    expect(credentials.set).toHaveBeenCalledWith(remote.url, "ghp_x");
    expect(text()).toContain("Using a pasted token.");
    expect(credentials.status).toHaveBeenCalledTimes(1);
    await click("Use my git credentials");
    expect(credentials.delete).toHaveBeenCalledWith(remote.url);
    expect(text()).toContain("Using your git credentials (ada).");
  });

  it("asks for a token when no credential is found", async () => {
    const { text } = await render({ setup: "off" }, null);
    expect(text()).toContain("No git credentials found");
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
    expect(text()).toContain("Create a token with only this access");
  });

  it("shows why sync stopped, and the way on", async () => {
    const diverged = await render({ setup: "on", fault: "diverged", detail: "Changed here and on the remote: a.md." });
    expect(diverged.text()).toContain("a.md");
    await click("Try again");
    expect(diverged.sync.resume).toHaveBeenCalled();
    act(() => root?.unmount());

    const paused = await render({
      setup: "on",
      fault: "paused",
      summary: { since: null, localFiles: ["a.md"], remoteFiles: ["b.md", "c.md"], people: ["Bo"] },
    });
    expect(paused.text()).toContain("You have 1 local changes since you started; the remote has 2 from Bo.");
    await click("Sync now");
    expect(paused.sync.resume).toHaveBeenCalled();
  });

  it("turns off for everyone only on a second, confirming click", async () => {
    const { sync } = await render({ setup: "on" });
    await click("Turn off for everyone");
    expect(sync.turnOffForEveryone).not.toHaveBeenCalled();
    await click("Everyone stops syncing. Turn off?");
    expect(sync.turnOffForEveryone).toHaveBeenCalled();
  });
});
