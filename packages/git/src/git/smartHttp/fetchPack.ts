/**
 * Protocol-v2 `fetch` for exact object ids, in one request: every `have`
 * is sent with `done`, so the server skips negotiation rounds and answers
 * with the pack straight away. Not a thin pack, so it indexes on its own.
 */
import {
  DELIM_PKT,
  FLUSH_PKT,
  RemoteProtocolError,
  assertNotErr,
  concatBytes,
  decodePktLines,
  demuxSideband,
  encodePktLine,
  pktText,
} from "./pktLine";
import { AGENT } from "./lsRefs";
import type { GitTransport } from "./transport";

export function fetchRequest(wants: string[], haves: string[]): Uint8Array {
  return concatBytes([
    encodePktLine("command=fetch\n"),
    encodePktLine(`${AGENT}\n`),
    DELIM_PKT,
    encodePktLine("ofs-delta\n"),
    encodePktLine("no-progress\n"),
    ...wants.map((oid) => encodePktLine(`want ${oid}\n`)),
    ...haves.map((oid) => encodePktLine(`have ${oid}\n`)),
    encodePktLine("done\n"),
    FLUSH_PKT,
  ]);
}

/** The pack from a v2 fetch reply (the side-banded `packfile` section). */
export function parseFetchReply(reply: Uint8Array): Uint8Array {
  const { lines } = decodePktLines(reply);
  const start = lines.findIndex((line) => {
    assertNotErr(line);
    return pktText(line) === "packfile";
  });
  if (start < 0) {
    throw new RemoteProtocolError("fetch reply has no packfile section");
  }
  const end = lines.findIndex((line, i) => i > start && line.type !== "data");
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const pack = demuxSideband(section).data;
  if (new TextDecoder().decode(pack.subarray(0, 4)) !== "PACK") {
    throw new RemoteProtocolError("fetch reply's packfile is not a pack");
  }
  return pack;
}

export async function fetchPack(
  transport: GitTransport,
  wants: string[],
  haves: string[],
): Promise<Uint8Array> {
  const reply = await transport.exchange(
    "git-upload-pack",
    fetchRequest(wants, haves),
    { protocolV2: true },
  );
  return parseFetchReply(reply);
}
