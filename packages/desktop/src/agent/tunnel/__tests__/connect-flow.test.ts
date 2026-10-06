/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  encodePairingCode,
  generatePairingSecret,
} from "@notefig/shared/tunnel";
import type { KvApi } from "@/utils/kv-store";
import { testKv } from "@/testing/test-kv";
import {
  TUNNEL_KV_NAMESPACE,
  TUNNEL_PAIRING_KEY,
  createTunnelPairing,
  pairingCodeFromHash,
  type TunnelPairingApi,
} from "../connect-flow";
import { TunnelConnection } from "../tunnel-connection";
import { FakeWorker } from "./fake-worker";

const WORKSPACE = "/remote/book";

function codeFor(worker: FakeWorker): string {
  return encodePairingCode(worker.secret, "wss://fake.example");
}

let kv: KvApi;
let tunnelConnection: TunnelConnection;
let tunnel: TunnelPairingApi;

/** Point the tunnel at a fake worker's socket for this test. */
function useWorker(options: ConstructorParameters<typeof FakeWorker>[0] = {}) {
  const worker = new FakeWorker({ workspacePath: WORKSPACE, ...options });
  (tunnelConnection as any).socketFactory = worker.socketFactory;
  return worker;
}

beforeEach(() => {
  kv = testKv();
  tunnelConnection = new TunnelConnection();
  tunnel = createTunnelPairing({
    kv,
    connection: tunnelConnection,
    onDisconnect: async () => {},
  });
});

afterEach(() => {
  tunnelConnection.disconnect();
});

describe("connect-flow", () => {
  it("connects and persists the pairing (worker info returned)", async () => {
    const worker = useWorker({ workerName: "studio" });
    const info = await tunnel.connect(codeFor(worker));

    expect(info.workspacePath).toBe(WORKSPACE);
    expect(info.name).toBe("studio");

    const stored = await tunnel.stored();
    expect(stored?.workerName).toBe("studio");
    expect(stored?.workspacePath).toBe(WORKSPACE);
  });

  it("does not persist a pairing when the handshake fails", async () => {
    useWorker();
    const badCode = encodePairingCode(
      generatePairingSecret(), // wrong secret
      "wss://fake.example",
    );
    await expect(tunnel.connect(badCode)).rejects.toMatchObject({
      type: "pairing_failed",
    });
    expect(await tunnel.stored()).toBeUndefined();
  });

  it("auto-connects a stored pairing on boot", async () => {
    const worker = useWorker();
    await tunnel.connect(codeFor(worker));
    tunnelConnection.disconnect();

    // New boot: a fresh worker answers (same secret works — the code embeds it).
    const rebooted = useWorker();
    // Reuse the stored code's secret by pointing the fake at it.
    (rebooted as any).secret = worker.secret;
    const info = await tunnel.autoConnect();
    expect(info?.workspacePath).toBe(WORKSPACE);
  });

  it("returns null (no throw) when auto-connect fails", async () => {
    // Stored pairing exists but the worker is gone / wrong secret.
    const worker = useWorker();
    await tunnel.connect(codeFor(worker));
    tunnelConnection.disconnect();

    const other = useWorker();
    (other as any).secret = generatePairingSecret(); // mismatched
    expect(await tunnel.autoConnect()).toBeNull();
  });

  it("forget clears the stored pairing", async () => {
    const worker = useWorker();
    await tunnel.connect(codeFor(worker));
    await tunnel.forget();
    expect(await tunnel.stored()).toBeUndefined();
  });

  it("re-pairs while already connected without throwing", async () => {
    // The reported bug: a second connect on a live tunnel used to throw
    // "already connected". connect now tears the old one down first.
    const first = useWorker({ workerName: "first" });
    await tunnel.connect(codeFor(first));
    expect(tunnelConnection.getState().status).toBe("connected");

    const second = useWorker({ workerName: "second" });
    const info = await tunnel.connect(codeFor(second));
    expect(info.name).toBe("second");
    expect(tunnelConnection.getState().status).toBe("connected");
  });
});

describe("watchCrossTab", () => {
  it("connects a disconnected tab when another tab writes a pairing", async () => {
    const worker = useWorker();
    const cleanup = tunnel.watchCrossTab();

    // The other tab's write. In the browser its commit reaches this tab through
    // the collection's coordinator; here, writing to the same collection is the
    // same signal from this side of that boundary.
    await kv.write(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, {
      code: codeFor(worker),
    });

    await vi.waitFor(() => {
      expect(tunnelConnection.getState().status).toBe("connected");
    });
    cleanup();
  });

  it("ignores other keys in the namespace and the pairing being cleared", async () => {
    const worker = useWorker();
    await kv.write(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, {
      code: codeFor(worker),
    });
    const cleanup = tunnel.watchCrossTab();

    // A neighbouring key must not look like a pairing...
    await kv.write(TUNNEL_KV_NAMESPACE, "something-else", "x");
    // ...and neither must a tab that just signed out, even though the pairing
    // row it deleted is exactly the key being watched.
    await tunnel.forget();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tunnelConnection.getState().status).toBe("disconnected");
    cleanup();
    await kv.remove(TUNNEL_KV_NAMESPACE, "something-else");
  });
});

describe("pairingCodeFromHash", () => {
  it("parses a valid code out of a fragment and rejects junk", () => {
    const code = encodePairingCode(generatePairingSecret(), "wss://x.example");
    expect(pairingCodeFromHash(`#${code}`)).toBe(code);
    expect(pairingCodeFromHash(code)).toBe(code);
    expect(pairingCodeFromHash("")).toBeNull();
    expect(pairingCodeFromHash("#not-a-code")).toBeNull();
  });
});
