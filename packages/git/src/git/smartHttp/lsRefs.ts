/**
 * Protocol-v2 `ls-refs` (gitprotocol-v2): one POST to upload-pack, no
 * prior capability advertisement. This is the poll, so it stays one
 * request with no discovery round trip.
 */
import type { GitRemoteRef } from "../types";
import {
  DELIM_PKT,
  FLUSH_PKT,
  RemoteProtocolError,
  assertNotErr,
  concatBytes,
  decodePktLines,
  encodePktLine,
  pktText,
} from "./pktLine";
import type { GitTransport } from "./transport";

export const AGENT = "agent=git/notefig";

export function lsRefsRequest(prefixes: string[]): Uint8Array {
  return concatBytes([
    encodePktLine("command=ls-refs\n"),
    encodePktLine(`${AGENT}\n`),
    DELIM_PKT,
    ...prefixes.map((prefix) => encodePktLine(`ref-prefix ${prefix}\n`)),
    FLUSH_PKT,
  ]);
}

const REF_LINE = /^([0-9a-f]{40}) (\S+)/;

export function parseLsRefs(reply: Uint8Array): GitRemoteRef[] {
  const refs: GitRemoteRef[] = [];
  for (const line of decodePktLines(reply).lines) {
    if (line.type !== "data") break;
    assertNotErr(line);
    const match = REF_LINE.exec(pktText(line) ?? "");
    if (!match) {
      throw new RemoteProtocolError(
        `unexpected ls-refs line: ${pktText(line)}`,
      );
    }
    refs.push({ oid: match[1], ref: match[2] });
  }
  return refs;
}

/** The remote's refs under any of `prefixes` (all refs when empty). */
export async function lsRefs(
  transport: GitTransport,
  prefixes: string[],
): Promise<GitRemoteRef[]> {
  const reply = await transport.exchange(
    "git-upload-pack",
    lsRefsRequest(prefixes),
    { protocolV2: true },
  );
  return parseLsRefs(reply);
}
