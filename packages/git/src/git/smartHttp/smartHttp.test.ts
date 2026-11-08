import {
  DELIM_PKT,
  FLUSH_PKT,
  RemoteProtocolError,
  concatBytes,
  decodePktLines,
  demuxSideband,
  encodePktLine,
  pktText,
} from "./pktLine";
import {
  chooseCapabilities,
  parseAdvertisedCapabilities,
  parseReportStatus,
  receivePack,
  receivePackRequest,
} from "./receivePack";
import { lineMerge } from "../repo/lineMerge";
import { toGitError } from "../errors";
import { ZERO_OID } from "../types";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (s: string) => new TextEncoder().encode(s);
const A = "a".repeat(40);
const B = "b".repeat(40);
const band = (channel: number, payload: Uint8Array | string) =>
  encodePktLine(
    concatBytes([
      new Uint8Array([channel]),
      typeof payload === "string" ? bytes(payload) : payload,
    ]),
  );

describe("pkt-line", () => {
  it("encodes the length (which counts the 4 header bytes) in hex", () => {
    expect(text(encodePktLine("a\n"))).toBe("0006a\n");
    expect(text(encodePktLine(""))).toBe("0004");
  });

  it("round-trips data, flush, delim and response-end", () => {
    const wire = concatBytes([
      encodePktLine("command=ls-refs\n"),
      DELIM_PKT,
      encodePktLine(new Uint8Array([0, 1, 255])),
      bytes("0002"),
      FLUSH_PKT,
    ]);
    const { lines, rest } = decodePktLines(wire);
    expect(lines.map((l) => l.type)).toEqual([
      "data",
      "delim",
      "data",
      "response-end",
      "flush",
    ]);
    expect(pktText(lines[0])).toBe("command=ls-refs");
    expect(lines[2]).toEqual({
      type: "data",
      data: new Uint8Array([0, 1, 255]),
    });
    expect(rest).toHaveLength(0);
  });

  it("stops at an unframed PACK and hands back the rest", () => {
    const wire = concatBytes([
      encodePktLine("x\n"),
      FLUSH_PKT,
      bytes("PACKdata"),
    ]);
    const { lines, rest } = decodePktLines(wire);
    expect(lines).toHaveLength(2);
    expect(text(rest)).toBe("PACKdata");
  });

  it("rejects malformed and truncated lines", () => {
    expect(() => decodePktLines(bytes("zzzz"))).toThrow(/malformed/);
    expect(() => decodePktLines(bytes("0010abc"))).toThrow(/truncated/);
    expect(() => encodePktLine(new Uint8Array(65517))).toThrow(/too long/);
  });

  it("demultiplexes side-band and surfaces channel 3 and ERR as remote errors", () => {
    const { lines } = decodePktLines(
      concatBytes([band(1, "PA"), band(2, "Counting\n"), band(1, "CK")]),
    );
    expect(demuxSideband(lines)).toEqual({
      data: bytes("PACK"),
      messages: ["Counting\n"],
    });

    const fatal = decodePktLines(band(3, "boom\n")).lines;
    expect(() => demuxSideband(fatal)).toThrow(new RemoteProtocolError("boom"));
    const err = decodePktLines(encodePktLine("ERR access denied\n")).lines;
    expect(() => demuxSideband(err)).toThrow("access denied");
  });
});

describe("receive-pack", () => {
  const advert = concatBytes([
    encodePktLine("# service=git-receive-pack\n"),
    FLUSH_PKT,
    encodePktLine(
      `${A} refs/heads/main\0report-status atomic delete-refs side-band-64k ofs-delta\n`,
    ),
    FLUSH_PKT,
  ]);

  it("reads capabilities from the advertisement", () => {
    expect(parseAdvertisedCapabilities(advert)).toEqual(
      new Set([
        "report-status",
        "atomic",
        "delete-refs",
        "side-band-64k",
        "ofs-delta",
      ]),
    );
  });

  it("chooses report-status, atomic only when asked, side-band when offered", () => {
    const caps = parseAdvertisedCapabilities(advert);
    const update = { ref: "refs/heads/main", old: A, new: B };
    expect(chooseCapabilities(caps, [update], false)).toEqual([
      "report-status",
      "side-band-64k",
      "agent=git/notefig",
    ]);
    expect(chooseCapabilities(caps, [update], true)).toContain("atomic");
    expect(() =>
      chooseCapabilities(new Set(["report-status"]), [update], true),
    ).toThrow(/atomic/);
    expect(() =>
      chooseCapabilities(
        new Set(["report-status"]),
        [{ ...update, new: ZERO_OID }],
        false,
      ),
    ).toThrow(/delete-refs/);
  });

  it("puts capabilities on the first command only, then the pack", () => {
    const body = receivePackRequest(
      [
        { ref: "refs/heads/main", old: A, new: B },
        { ref: "refs/notefig/x", old: ZERO_OID, new: A },
      ],
      ["report-status", "atomic"],
      bytes("PACK"),
    );
    const { lines, rest } = decodePktLines(body);
    expect(pktText(lines[0])).toBe(
      `${A} ${B} refs/heads/main\0report-status atomic`,
    );
    expect(pktText(lines[1])).toBe(`${ZERO_OID} ${A} refs/notefig/x`);
    expect(lines[2].type).toBe("flush");
    expect(text(rest)).toBe("PACK");
  });

  it("parses report-status, plain or inside side-band 1", () => {
    const updates = [
      { ref: "refs/heads/main", old: A, new: B },
      { ref: "refs/notefig/x", old: ZERO_OID, new: A },
    ];
    const status = concatBytes([
      encodePktLine("unpack ok\n"),
      encodePktLine("ok refs/heads/main\n"),
      encodePktLine("ng refs/notefig/x stale info\n"),
      FLUSH_PKT,
    ]);
    const expected = {
      ok: false,
      unpack: "ok",
      refs: [
        { ref: "refs/heads/main", ok: true },
        { ref: "refs/notefig/x", ok: false, reason: "stale info" },
      ],
      messages: [],
    };
    expect(parseReportStatus(status, updates, false)).toEqual(expected);
    const banded = concatBytes([
      band(2, "hook says hi\n"),
      band(1, status),
      FLUSH_PKT,
    ]);
    expect(parseReportStatus(banded, updates, true)).toEqual({
      ...expected,
      messages: ["hook says hi\n"],
    });
    expect(() => parseReportStatus(FLUSH_PKT, updates, false)).toThrow(
      /report-status/,
    );
  });

  it("an incomplete or cut-off report is an unknown outcome, never a failure", async () => {
    const updates = [
      { ref: "refs/heads/main", old: A, new: B },
      { ref: "refs/notefig/x", old: ZERO_OID, new: A },
    ];
    const unpackOk = encodePktLine("unpack ok\n");
    const okMain = encodePktLine("ok refs/heads/main\n");
    const ngX = encodePktLine("ng refs/notefig/x stale info\n");
    const cut = (reply: Uint8Array) => reply.subarray(0, reply.length - 3);
    const replies: Array<[string, Uint8Array, boolean]> = [
      ["missing ref status", concatBytes([unpackOk, okMain, FLUSH_PKT]), false],
      ["no flush", concatBytes([unpackOk, okMain, ngX]), false],
      ["cut mid-packet", cut(concatBytes([unpackOk, okMain, ngX])), false],
      ["cut mid-header", concatBytes([unpackOk, okMain, bytes("00")]), false],
      [
        "side-band cut mid-packet",
        cut(concatBytes([band(1, concatBytes([unpackOk, okMain])), FLUSH_PKT])),
        true,
      ],
      [
        "side-band report missing a ref",
        concatBytes([
          band(1, concatBytes([unpackOk, okMain, FLUSH_PKT])),
          FLUSH_PKT,
        ]),
        true,
      ],
    ];
    const outcomes: Record<string, string> = {};
    for (const [label, reply, sideband] of replies) {
      const transport = {
        advertise: async () => new Uint8Array(),
        exchange: async () => reply,
      };
      const capabilities = sideband
        ? ["report-status", "side-band-64k"]
        : ["report-status"];
      outcomes[label] = await receivePack(transport, {
        updates,
        capabilities,
        pack: null,
      }).then(
        () => "resolved",
        (error: Error) => error.name,
      );
    }
    expect(outcomes).toEqual(
      Object.fromEntries(
        replies.map(([label]) => [label, "PushOutcomeUnknownError"]),
      ),
    );
  });
});

describe("lineMerge (the default driver)", () => {
  it("merges separate edits and marks overlapping ones", () => {
    expect(lineMerge("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toEqual({
      content: "A\nb\nC\n",
      conflicted: false,
    });
    expect(lineMerge("a\n", "x\n", "y\n")).toEqual({
      content: "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n",
      conflicted: true,
    });
  });
});

describe("toGitError", () => {
  it.each([
    [{ name: "GitHttpStatusError", status: 401, message: "" }, "AuthRequired"],
    [{ name: "GitHttpStatusError", status: 403, message: "" }, "AuthFailed"],
    [{ name: "GitHttpStatusError", status: 404, message: "" }, "RepoNotFound"],
    [{ name: "GitHttpStatusError", status: 429, message: "" }, "Throttled"],
    [{ name: "GitHttpStatusError", status: 500, message: "" }, "Network"],
    [
      { name: "HttpError", data: { statusCode: 401 }, message: "" },
      "AuthRequired",
    ],
    [
      { name: "HttpError", data: { statusCode: 403 }, message: "" },
      "AuthFailed",
    ],
    [
      { name: "HttpError", data: { statusCode: 404 }, message: "" },
      "RepoNotFound",
    ],
    [
      { name: "HttpError", data: { statusCode: 429 }, message: "" },
      "Throttled",
    ],
    [{ name: "HttpError", data: { statusCode: 503 }, message: "" }, "Network"],
    [{ name: "SmartHttpError", message: "" }, "RemoteError"],
    [{ name: "ParseError", message: "" }, "RemoteError"],
    [{ name: "EmptyServerResponseError", message: "" }, "RemoteError"],
    [{ name: "GitTransportError", message: "" }, "Network"],
    [{ name: "PushOutcomeUnknownError", message: "" }, "PushOutcomeUnknown"],
    [{ name: "RemoteProtocolError", message: "" }, "RemoteError"],
    [{ name: "NotFoundError", message: "" }, "RepoNotFound"],
    [new Error("weird"), "CorruptRepository"],
  ])("%j → %s", (error, code) => {
    expect(toGitError(error).code).toBe(code);
  });
});
