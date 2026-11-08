/**
 * git's pkt-line framing (gitprotocol-common): each line is a 4-hex-digit
 * length (which counts itself) and a payload. Three special lengths carry
 * no payload: `0000` flush, `0001` delim (protocol v2 section separator)
 * and `0002` response-end. isomorphic-git doesn't export its codec.
 */

export type PktLine =
  | { type: "data"; data: Uint8Array }
  | { type: "flush" }
  | { type: "delim" }
  | { type: "response-end" };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_PKT_PAYLOAD = 65516;

export const FLUSH_PKT = encoder.encode("0000");
export const DELIM_PKT = encoder.encode("0001");

/** One data pkt-line around a string or bytes. */
export function encodePktLine(payload: string | Uint8Array): Uint8Array {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  if (bytes.length > MAX_PKT_PAYLOAD) {
    throw new Error(`pkt-line payload too long (${bytes.length} bytes)`);
  }
  const header = encoder.encode(
    (bytes.length + 4).toString(16).padStart(4, "0"),
  );
  return concatBytes([header, bytes]);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const SPECIAL: Record<number, PktLine> = {
  0: { type: "flush" },
  1: { type: "delim" },
  2: { type: "response-end" },
};

/**
 * Split bytes into pkt-lines. Stops at the first `PACK` signature (a v0
 * pack that follows the commands is not framed); `rest` holds what's left.
 */
export function decodePktLines(bytes: Uint8Array): {
  lines: PktLine[];
  rest: Uint8Array;
} {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const head = decoder.decode(bytes.subarray(offset, offset + 4));
    if (head === "PACK") break;
    const length = Number.parseInt(head, 16);
    if (!/^[0-9a-f]{4}$/i.test(head) || length === 3) {
      throw new RemoteProtocolError(`malformed pkt-line header "${head}"`);
    }
    if (length < 4) {
      lines.push(SPECIAL[length]);
      offset += 4;
      continue;
    }
    if (offset + length > bytes.length) {
      throw new RemoteProtocolError("truncated pkt-line");
    }
    lines.push({
      type: "data",
      data: bytes.slice(offset + 4, offset + length),
    });
    offset += length;
  }
  return { lines, rest: bytes.slice(offset) };
}

/** A data line's payload as text, without its trailing newline. */
export function pktText(line: PktLine): string | null {
  if (line.type !== "data") return null;
  const text = decoder.decode(line.data);
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Throw the remote's own message when a line is an `ERR` packet. */
export function assertNotErr(line: PktLine): void {
  const text = pktText(line);
  if (text?.startsWith("ERR ")) {
    throw new RemoteProtocolError(text.slice(4), true);
  }
}

/**
 * The remote said something we can't use: an error it reported itself
 * (`fromRemote`: an `ERR` packet, side-band channel 3) or a reply we
 * couldn't parse.
 */
export class RemoteProtocolError extends Error {
  constructor(
    message: string,
    readonly fromRemote = false,
  ) {
    super(message);
    this.name = "RemoteProtocolError";
  }
}

export interface Sideband {
  /** Channel 1, concatenated. */
  data: Uint8Array;
  /** Channel 2 (progress, hook output), one entry per packet. */
  messages: string[];
}

/**
 * Demultiplex side-band-64k packets (first payload byte is the channel).
 * Channel 3 is a fatal remote error.
 */
export function demuxSideband(lines: PktLine[]): Sideband {
  const data: Uint8Array[] = [];
  const messages: string[] = [];
  for (const line of lines) {
    if (line.type !== "data" || line.data.length === 0) continue;
    assertNotErr(line);
    const payload = line.data.subarray(1);
    switch (line.data[0]) {
      case 1:
        data.push(payload);
        break;
      case 2:
        messages.push(decoder.decode(payload));
        break;
      case 3:
        throw new RemoteProtocolError(decoder.decode(payload).trim(), true);
      default:
        throw new RemoteProtocolError(
          `unknown side-band channel ${line.data[0]}`,
        );
    }
  }
  return { data: concatBytes(data), messages };
}
