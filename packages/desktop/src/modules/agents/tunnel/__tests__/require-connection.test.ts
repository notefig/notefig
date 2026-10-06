/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
  mocks: { web: true, status: "disconnected" as string },
}));

vi.mock("@/utils/platform", () => ({ isWeb: () => mocks.web }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));
vi.mock("../pair-dialog-store", () => ({ openPairDialog: vi.fn() }));
vi.mock("../tunnel-connection", () => ({
  tunnelConnection: { getState: () => ({ status: mocks.status }) },
}));

import { toast } from "sonner";
import { openPairDialog } from "../pair-dialog-store";
import { ensureAgentRuntime } from "../require-connection";

beforeEach(() => {
  mocks.web = true;
  mocks.status = "disconnected";
  vi.clearAllMocks();
});

afterEach(() => vi.clearAllMocks());

describe("ensureAgentRuntime", () => {
  it("passes on desktop without touching the tunnel", () => {
    mocks.web = false;
    expect(ensureAgentRuntime()).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("passes on web when the tunnel is connected", () => {
    mocks.status = "connected";
    expect(ensureAgentRuntime()).toBe(true);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("blocks + snackbars on web when disconnected, action opens the dialog", () => {
    expect(ensureAgentRuntime()).toBe(false);
    expect(toast.error).toHaveBeenCalledTimes(1);
    const opts = (toast.error as any).mock.calls[0][1];
    opts.action.onClick();
    expect(openPairDialog).toHaveBeenCalledTimes(1);
  });

  it("blocks while connecting too (only 'connected' passes)", () => {
    mocks.status = "connecting";
    expect(ensureAgentRuntime()).toBe(false);
  });
});
