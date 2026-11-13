import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoreProvider } from "@notefig/core/react";
import "@/utils/intl";
import { createTestCore } from "@/testing/test-core";
import type { CredentialStatus, CredentialsSurface } from "@/adapters/platform-adapter.interface";
import { INITIAL_SYNC_STATE, type SyncState, type WorkspaceSync } from "@/modules/sync";
import { SyncPanel } from "../remote-panel";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const remote = { url: "https://github.com/team/notes.git", branch: "main" };
const ada: CredentialStatus = { source: "git", username: "ada" };

const workspacePath = "/work/notes";

function fakeSync(): WorkspaceSync {
  return {
    workspacePath,
    turnOn: vi.fn(async () => {}),
    decline: vi.fn(async () => {}),
    turnOffForEveryone: vi.fn(async () => {}),
    resume: vi.fn(),
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

const button = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find((b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label)!;
const click = (label: string) => act(async () => button(label).click());
/** The buttons under the message: the way on from where sync is. */
const actions = () => [...document.querySelectorAll("[data-sync-actions] button")].map((b) => b.textContent?.trim());
/** The tool bar's controls, by label. */
const bar = () => ["Sync now", "More"].filter((label) => button(label));
/** Open the tool bar's menu (Radix opens it on pointerdown). */
const openMenu = () =>
  act(async () => {
    button("More").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
  });

describe("the Remote tool", () => {
  it("offers to turn on a project, naming the remote and the credential, and shows what to fix", async () => {
    const { sync, text } = await render({ setup: "off" });
    expect(document.querySelector("[data-sync-remote]")?.textContent).toContain("github.com/team/notesmain");
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

    expect(credentials.set).toHaveBeenCalledWith(remote.url, workspacePath, "ghp_x");
    expect(text()).toContain("Using a pasted token.");
    expect(credentials.status).toHaveBeenCalledTimes(1);
    await click("Use my git credentials");
    expect(credentials.delete).toHaveBeenCalledWith(remote.url, workspacePath);
    expect(text()).toContain("Using your git credentials (ada).");
  });

  it("signs in over SSH with the ssh-agent, with no token to paste", async () => {
    const { credentials, text } = await render({ setup: "on", remote: { url: "git@github.com:team/notes.git", branch: "main" } });
    expect(text()).toContain("Using SSH (your ssh-agent).");
    expect(credentials.status).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="password"]')).toBeNull();
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
    await click("Keep my versions and go on");
    expect(diverged.sync.resume).toHaveBeenCalled();
    act(() => root?.unmount());

    const paused = await render({
      setup: "on",
      fault: "paused",
      summary: { since: null, localFiles: ["a.md"], remoteFiles: ["b.md", "c.md"], people: ["Bo"] },
    });
    expect(paused.text()).toContain("You have 1 local changes since you started; the remote has 2 from Bo.");
    await click("Go on");
    expect(paused.sync.resume).toHaveBeenCalled();
  });

  it.each([
    ["off", { setup: "off" }, ["Turn on sync"], []],
    ["ask", { setup: "ask" }, ["Sync on this device", "Not now"], []],
    ["declined", { setup: "declined" }, ["Turn on sync"], []],
    ["idle", { setup: "on" }, [], ["Sync now", "More"]],
    ["pushing", { setup: "on", activity: "pushing" }, [], ["Sync now", "More"]],
    ["offline", { setup: "on", fault: "offline", detail: "Can't reach it." }, [], ["Sync now", "More"]],
    ["throttled", { setup: "on", fault: "throttled", detail: "Slow down." }, [], ["Sync now", "More"]],
    ["auth-error", { setup: "on", fault: "auth-error", detail: "Rejected." }, ["Try again"], ["More"]],
    ["diverged", { setup: "on", fault: "diverged", detail: "a.md" }, ["Keep my versions and go on"], ["More"]],
    [
      "paused",
      { setup: "on", fault: "paused", summary: { since: null, localFiles: [], remoteFiles: [], people: [] } },
      ["Go on"],
      ["More"],
    ],
  ] as const)("lays out %s the same way: the remote's rows, a message, its way on", async (status, state, ways, controls) => {
    await render(state as Partial<SyncState>);
    expect(document.querySelector("[data-sync-panel]")?.getAttribute("data-sync-panel")).toBe(status);
    expect(document.querySelector("[data-sync-remote]")?.textContent).toContain("github.com/team/notes");
    expect(actions()).toEqual(ways);
    expect(bar()).toEqual(controls);
  });

  it("offers nothing to press where sync can't run, only why", async () => {
    const { text } = await render({ setup: "unavailable", remote: null, reason: "No remote to sync with." });
    expect(text()).toContain("No remote to sync with.");
    expect(document.querySelectorAll("button")).toHaveLength(0);
  });

  it("tries again after a sign-in failure, over SSH too, by resuming", async () => {
    const { sync, text } = await render({
      setup: "on",
      fault: "auth-error",
      detail: "Host key verification failed.",
      remote: { url: "git@github.com:team/notes.git", branch: "main" },
    });
    expect(text()).toContain("Host key verification failed.");
    await click("Try again");
    expect(sync.resume).toHaveBeenCalled();
    expect(sync.syncNow).not.toHaveBeenCalled();
  });

  it("syncs now from the tool bar while running", async () => {
    const { sync } = await render({ setup: "on" });
    await click("Sync now");
    expect(sync.syncNow).toHaveBeenCalled();
    expect(sync.resume).not.toHaveBeenCalled();
  });

  it("stops on this device, or turns off for everyone after a confirming dialog, from the menu", async () => {
    const { sync } = await render({ setup: "on" });
    await openMenu();
    await click("Stop on this device");
    expect(sync.decline).toHaveBeenCalled();

    await openMenu();
    await click("Turn off for everyone…");
    expect(sync.turnOffForEveryone).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Turn off sync for everyone?");
    await click("Turn off for everyone");
    expect(sync.turnOffForEveryone).toHaveBeenCalled();
  });
});
