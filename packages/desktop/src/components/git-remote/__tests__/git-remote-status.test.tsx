import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CoreProvider } from "@notefig/core/react";
import "@/utils/intl";
import { createTestCore } from "@/testing/test-core";
import type { CredentialStatus, CredentialsSurface } from "@/adapters/platform-adapter.interface";
import type { WorkspaceGitRemote } from "@/modules/git-remote";
import { GitRemotePanel } from "../git-remote-status";

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

const url = "https://github.com/team/notes.git";
const ada: CredentialStatus = { source: "git", username: "ada" };
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

async function render(target: Awaited<ReturnType<WorkspaceGitRemote["target"]>>, credential: CredentialStatus | null = ada) {
  const credentials: CredentialsSurface = {
    supported: true,
    status: vi.fn(async () => credential),
    set: vi.fn(async () => ({ source: "stored", username: "x-access-token" }) as const),
    delete: vi.fn(async () => ada),
  };
  const remote = { target: vi.fn(async () => target), push: vi.fn(async () => "pushed" as const) } as unknown as WorkspaceGitRemote;
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () =>
    root!.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { mutations: { retry: false } } }) },
        createElement(CoreProvider, {
          core: createTestCore({ platform: { credentials } }),
          children: createElement(GitRemotePanel, { remote, workspacePath: "/ws" }),
        }),
      ),
    ),
  );
  // The target, then the credential it names.
  await flush();
  await flush();
  return { remote, credentials, text: () => host.textContent ?? "" };
}

const button = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!;
const click = async (label: string) => {
  await act(async () => button(label).click());
  await flush();
};

describe("the git remote popover", () => {
  it("names the branch, the remote and the credential, and pushes", async () => {
    const { remote, text } = await render({ url, branch: "main" });
    expect(text()).toContain("main");
    expect(text()).toContain("github.com/team/notes");
    expect(text()).toContain("Using your git credentials (ada).");
    await click("Push");
    expect(remote.push).toHaveBeenCalled();
    expect(text()).toContain("Pushed.");
  });

  it("shows what to fix when a push fails", async () => {
    const { remote, text } = await render({ url, branch: "main" });
    vi.mocked(remote.push).mockRejectedValueOnce(new Error("Pull them first, then push."));
    await click("Push");
    expect(text()).toContain("Pull them first, then push.");
  });

  it("says why there's nothing to push to", async () => {
    const { text } = await render({ problem: "Only HTTPS remotes are supported for now." });
    expect(text()).toContain("Only HTTPS remotes");
    expect(button("Push")).toBeUndefined();
  });

  it("switches to a pasted token and back in place, without asking Rust again", async () => {
    const { credentials, text } = await render({ url, branch: "main" });
    await click("Use a token instead");
    const input = document.querySelector("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ghp_x");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save");
    expect(credentials.set).toHaveBeenCalledWith(url, "ghp_x");
    expect(text()).toContain("Using a pasted token.");
    expect(credentials.status).toHaveBeenCalledTimes(1);

    await click("Use my git credentials");
    expect(credentials.delete).toHaveBeenCalledWith(url);
    expect(text()).toContain("Using your git credentials (ada).");
  });

  it("asks for a token when no credential is found", async () => {
    const { text } = await render({ url, branch: "main" }, null);
    expect(text()).toContain("No git credentials found");
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
  });
});
