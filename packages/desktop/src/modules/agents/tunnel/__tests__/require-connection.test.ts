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
import { agentRuntimeConnection } from "../require-connection";

beforeEach(() => {
  mocks.web = true;
  mocks.status = "disconnected";
  vi.clearAllMocks();
});

afterEach(() => vi.clearAllMocks());

describe("agentRuntimeConnection", () => {
  it("is connected on desktop without touching the tunnel", () => {
    mocks.web = false;
    expect(agentRuntimeConnection.connected()).toBe(true);
  });

  it("is connected on web while the tunnel is", () => {
    mocks.status = "connected";
    expect(agentRuntimeConnection.connected()).toBe(true);
  });

  it("isn't while connecting (only 'connected' counts)", () => {
    mocks.status = "connecting";
    expect(agentRuntimeConnection.connected()).toBe(false);
  });

  it("explains with a snackbar whose action opens the pairing dialog", () => {
    agentRuntimeConnection.explain();
    expect(toast.error).toHaveBeenCalledTimes(1);
    const opts = (toast.error as any).mock.calls[0][1];
    opts.action.onClick();
    expect(openPairDialog).toHaveBeenCalledTimes(1);
  });
});
