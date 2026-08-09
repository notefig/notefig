/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/adapters", async () => ({
  platformAdapter: {
    db: (await import("@/testing/node-db")).createNodeTestDb(),
  },
}));

import {
  encodePairingCode,
  generatePairingSecret,
} from "@notefig/shared/tunnel";
import {
  getOrCreateKvCollection,
  removeKv,
  writeKv,
} from "@/utils/kv-store";
import {
  TUNNEL_KV_NAMESPACE,
  TUNNEL_PAIRING_KEY,
  autoConnectStoredPairing,
  connectWithCode,
  forgetPairing,
  getStoredPairing,
  pairingCodeFromHash,
  watchCrossTabPairing,
} from "../connect-flow";
import { tunnelConnection } from "../tunnel-connection";
import { FakeWorker } from "./fake-worker";

const WORKSPACE = "/remote/book";

function codeFor(worker: FakeWorker): string {
  return encodePairingCode(worker.secret, "wss://fake.example");
}

/** Point the singleton tunnel at a fake worker's socket for this test. */
function useWorker(options: ConstructorParameters<typeof FakeWorker>[0] = {}) {
  const worker = new FakeWorker({ workspacePath: WORKSPACE, ...options });
  (tunnelConnection as any).socketFactory = worker.socketFactory;
  return worker;
}

beforeEach(async () => {
  await forgetPairing();
});

afterEach(() => {
  tunnelConnection.disconnect();
});

describe("connect-flow", () => {
  it("connects and persists the pairing (worker info returned)", async () => {
    const worker = useWorker({ workerName: "studio" });
    const info = await connectWithCode(codeFor(worker));

    expect(info.workspacePath).toBe(WORKSPACE);
    expect(info.name).toBe("studio");

    const stored = await getStoredPairing();
    expect(stored?.workerName).toBe("studio");
    expect(stored?.workspacePath).toBe(WORKSPACE);
  });

  it("does not persist a pairing when the handshake fails", async () => {
    useWorker();
    const badCode = encodePairingCode(
      generatePairingSecret(), // wrong secret
      "wss://fake.example",
    );
    await expect(connectWithCode(badCode)).rejects.toMatchObject({
      type: "pairing_failed",
    });
    expect(await getStoredPairing()).toBeUndefined();
  });

  it("auto-connects a stored pairing on boot", async () => {
    const worker = useWorker();
    await connectWithCode(codeFor(worker));
    tunnelConnection.disconnect();

    // New boot: a fresh worker answers (same secret works — the code embeds it).
    const rebooted = useWorker();
    // Reuse the stored code's secret by pointing the fake at it.
    (rebooted as any).secret = worker.secret;
    const info = await autoConnectStoredPairing();
    expect(info?.workspacePath).toBe(WORKSPACE);
  });

  it("returns null (no throw) when auto-connect fails", async () => {
    // Stored pairing exists but the worker is gone / wrong secret.
    const worker = useWorker();
    await connectWithCode(codeFor(worker));
    tunnelConnection.disconnect();

    const other = useWorker();
    (other as any).secret = generatePairingSecret(); // mismatched
    expect(await autoConnectStoredPairing()).toBeNull();
  });

  it("forgetPairing clears the stored pairing", async () => {
    const worker = useWorker();
    await connectWithCode(codeFor(worker));
    await forgetPairing();
    expect(await getStoredPairing()).toBeUndefined();
  });

  it("re-pairs while already connected without throwing", async () => {
    // The reported bug: a second connect on a live tunnel used to throw
    // "already connected". connectWithCode now tears the old one down first.
    const first = useWorker({ workerName: "first" });
    await connectWithCode(codeFor(first));
    expect(tunnelConnection.getState().status).toBe("connected");

    const second = useWorker({ workerName: "second" });
    const info = await connectWithCode(codeFor(second));
    expect(info.name).toBe("second");
    expect(tunnelConnection.getState().status).toBe("connected");
  });
});

describe("watchCrossTabPairing", () => {
  it("connects a disconnected tab when another tab writes a pairing", async () => {
    const worker = useWorker();
    const cleanup = watchCrossTabPairing();

    // The other tab's write. In the browser its commit reaches this tab through
    // the collection's coordinator; here, writing to the same collection is the
    // same signal from this side of that boundary.
    await writeKv(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, {
      code: codeFor(worker),
    });

    await vi.waitFor(() => {
      expect(tunnelConnection.getState().status).toBe("connected");
    });
    cleanup();
  });

  it("does not auto-connect on the pairing it already had at boot", async () => {
    // The watcher mounts before the collection has hydrated, so the stored
    // pairing arrives as a change moments later. Treating that as "another tab
    // paired" would connect behind App.tsx's back — which deliberately skips
    // the stored reconnect when the load carried a deep-link code.
    const worker = useWorker();
    await writeKv(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, {
      code: codeFor(worker),
    });
    // Back to an unhydrated collection, the state a fresh page load starts in.
    await getOrCreateKvCollection(TUNNEL_KV_NAMESPACE).cleanup();

    const cleanup = watchCrossTabPairing();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(tunnelConnection.getState().status).toBe("disconnected");
    cleanup();
  });

  it("ignores other keys in the namespace and the pairing being cleared", async () => {
    const worker = useWorker();
    await writeKv(TUNNEL_KV_NAMESPACE, TUNNEL_PAIRING_KEY, {
      code: codeFor(worker),
    });
    const cleanup = watchCrossTabPairing();

    // A neighbouring key must not look like a pairing...
    await writeKv(TUNNEL_KV_NAMESPACE, "something-else", "x");
    // ...and neither must a tab that just signed out, even though the pairing
    // row it deleted is exactly the key being watched.
    await forgetPairing();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tunnelConnection.getState().status).toBe("disconnected");
    cleanup();
    await removeKv(TUNNEL_KV_NAMESPACE, "something-else");
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
