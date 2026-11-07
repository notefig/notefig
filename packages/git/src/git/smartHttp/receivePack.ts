/**
 * Our receive-pack client (protocol v0, which is what push speaks on every
 * host): one POST of `old new ref` commands with `report-status` (and
 * `atomic` when asked), then the pack, then parse `unpack ok` and the
 * per-ref `ok`/`ng` lines. `old` is the compare-and-swap: `ZERO_OID` means
 * create-if-absent; `new = ZERO_OID` is a CAS delete. A push of only
 * deletes sends no pack.
 */
import {
  type GitPushRefsResult,
  type GitRefUpdate,
  type GitRefUpdateStatus,
  ZERO_OID,
} from "../types";
import {
  FLUSH_PKT,
  RemoteProtocolError,
  assertNotErr,
  concatBytes,
  decodePktLines,
  demuxSideband,
  encodePktLine,
  pktText,
  type PktLine,
} from "./pktLine";
import {
  GitHttpStatusError,
  GitTransportError,
  type GitTransport,
} from "./transport";

/** The push was sent, but whether it landed is unknown: re-poll. */
export class PushOutcomeUnknownError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PushOutcomeUnknownError";
  }
}

/** The remote lacks a capability the request needs. */
export class MissingCapabilityError extends Error {
  constructor(capability: string) {
    super(`The remote doesn't support "${capability}".`);
    this.name = "MissingCapabilityError";
  }
}

/** Capabilities from a v0 `info/refs?service=git-receive-pack` reply. */
export function parseAdvertisedCapabilities(reply: Uint8Array): Set<string> {
  for (const line of decodePktLines(reply).lines) {
    assertNotErr(line);
    const text = pktText(line);
    const nul = text?.indexOf("\0") ?? -1;
    if (text && nul >= 0) {
      return new Set(
        text
          .slice(nul + 1)
          .split(" ")
          .filter(Boolean),
      );
    }
  }
  throw new RemoteProtocolError("receive-pack advertised no capabilities");
}

export function chooseCapabilities(
  advertised: Set<string>,
  updates: GitRefUpdate[],
  atomic: boolean,
): string[] {
  const need = (capability: string) => {
    if (!advertised.has(capability))
      throw new MissingCapabilityError(capability);
    return capability;
  };
  const caps = [need("report-status")];
  if (atomic) caps.push(need("atomic"));
  if (updates.some((u) => u.new === ZERO_OID)) need("delete-refs");
  if (advertised.has("side-band-64k")) caps.push("side-band-64k");
  caps.push("agent=git/notefig");
  return caps;
}

export function receivePackRequest(
  updates: GitRefUpdate[],
  capabilities: string[],
  pack: Uint8Array | null,
): Uint8Array {
  const commands = updates.map((update, i) => {
    const command = `${update.old} ${update.new} ${update.ref}`;
    return encodePktLine(
      i === 0 ? `${command}\0${capabilities.join(" ")}\n` : `${command}\n`,
    );
  });
  return concatBytes([...commands, FLUSH_PKT, ...(pack ? [pack] : [])]);
}

function statusLines(
  reply: Uint8Array,
  sideband: boolean,
): {
  lines: PktLine[];
  messages: string[];
} {
  const outer = decodePktLines(reply).lines;
  if (!sideband) return { lines: outer, messages: [] };
  const { data, messages } = demuxSideband(outer);
  return { lines: decodePktLines(data).lines, messages };
}

/** Parse report-status into per-ref results, in the order the refs were sent. */
export function parseReportStatus(
  reply: Uint8Array,
  updates: GitRefUpdate[],
  sideband: boolean,
): GitPushRefsResult {
  const { lines, messages } = statusLines(reply, sideband);
  let unpack: string | null = null;
  const byRef = new Map<string, GitRefUpdateStatus>();
  for (const line of lines) {
    if (line.type !== "data") break;
    assertNotErr(line);
    const text = pktText(line) ?? "";
    if (text.startsWith("unpack ")) {
      unpack = text.slice("unpack ".length);
    } else if (text.startsWith("ok ")) {
      const ref = text.slice(3);
      byRef.set(ref, { ref, ok: true });
    } else if (text.startsWith("ng ")) {
      const [ref, ...reason] = text.slice(3).split(" ");
      byRef.set(ref, { ref, ok: false, reason: reason.join(" ") });
    }
  }
  if (unpack === null) {
    throw new RemoteProtocolError("push reply has no report-status");
  }
  const refs = updates.map(
    (update): GitRefUpdateStatus =>
      byRef.get(update.ref) ?? {
        ref: update.ref,
        ok: false,
        reason: `no status reported (unpack ${unpack})`,
      },
  );
  return {
    ok: unpack === "ok" && refs.every((r) => r.ok),
    unpack,
    refs,
    messages,
  };
}

/** Failures after the request may have reached the remote. */
function isOutcomeUnknown(error: unknown): boolean {
  if (error instanceof GitTransportError) return true;
  if (error instanceof RemoteProtocolError) return !error.fromRemote;
  return error instanceof GitHttpStatusError && error.status >= 500;
}

export interface ReceivePackInput {
  updates: GitRefUpdate[];
  capabilities: string[];
  /** Null when every update is a delete. */
  pack: Uint8Array | null;
}

export async function receivePack(
  transport: GitTransport,
  input: ReceivePackInput,
): Promise<GitPushRefsResult> {
  const body = receivePackRequest(
    input.updates,
    input.capabilities,
    input.pack,
  );
  try {
    const reply = await transport.exchange("git-receive-pack", body, {
      protocolV2: false,
    });
    return parseReportStatus(
      reply,
      input.updates,
      input.capabilities.includes("side-band-64k"),
    );
  } catch (error) {
    if (!isOutcomeUnknown(error)) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new PushOutcomeUnknownError(
      `Push outcome unknown (${reason}); re-read the remote refs.`,
      error,
    );
  }
}
