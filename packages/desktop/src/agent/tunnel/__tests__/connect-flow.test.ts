/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { kv } = vi.hoisted(() => ({ kv: new Map<string, unknown>() }));

vi.mock("@/adapters", () => ({
  platformAdapter: {
    getKv: vi.fn(async (ns: string, key: string) => kv.get(`${ns}:${key}`)),
    setKv: vi.fn(async (ns: string, key: string, value: unknown) => {
      kv.set(`${ns}:${key}`, value);
    }),
    deleteKv: vi.fn(async (ns: string, key: string) => {
      kv.delete(`${ns}:${key}`);
    }),
  },
}));

import { encodePairingCode, generatePairingSecret } from "@metrists/shared/tunnel";
import {
  autoConnectStoredPairing,
  connectWithCode,
  forgetPairing,
  getStoredPairing,
  pairingCodeFromHash,
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

beforeEach(() => {
  kv.clear();
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

describe("pairingCodeFromHash", () => {
  it("parses a valid code out of a fragment and rejects junk", () => {
    const code = encodePairingCode(generatePairingSecret(), "wss://x.example");
    expect(pairingCodeFromHash(`#${code}`)).toBe(code);
    expect(pairingCodeFromHash(code)).toBe(code);
    expect(pairingCodeFromHash("")).toBeNull();
    expect(pairingCodeFromHash("#not-a-code")).toBeNull();
  });
});
