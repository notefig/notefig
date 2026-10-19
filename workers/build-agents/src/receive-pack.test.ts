import { describe, expect, it } from "vitest";
import { onlyUpdates, readRefUpdates } from "./receive-pack.ts";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);
const ZERO = "0".repeat(40);

/** A push's pkt-line header, then the start of a pack. */
function push(lines: string[]): Uint8Array {
	const packets = lines.map((line, index) => {
		const text = `${line}${index === 0 ? "\0report-status side-band-64k" : ""}\n`;
		return `${(text.length + 4).toString(16).padStart(4, "0")}${text}`;
	});
	return new TextEncoder().encode(`${packets.join("")}0000PACK\0\0\0\x02`);
}

describe("readRefUpdates", () => {
	it("reads every ref update before the flush, ignoring capabilities and the pack", () => {
		expect(readRefUpdates(push([`${OLD} ${NEW} refs/heads/met-42`, `${ZERO} ${NEW} refs/tags/v1`]))).toEqual([
			{ oldOid: OLD, newOid: NEW, ref: "refs/heads/met-42" },
			{ oldOid: ZERO, newOid: NEW, ref: "refs/tags/v1" },
		]);
	});

	it("rejects a malformed or cut-off header", () => {
		expect(readRefUpdates(new TextEncoder().encode("zzzz"))).toBeNull();
		expect(readRefUpdates(push([`${OLD} ${NEW} refs/heads/met-42`]).subarray(0, 20))).toBeNull();
		expect(readRefUpdates(push(["not a ref update"]))).toBeNull();
	});
});

describe("onlyUpdates", () => {
	it("allows updates to the issue's branch only", () => {
		expect(onlyUpdates([{ oldOid: OLD, newOid: NEW, ref: "refs/heads/met-42" }], "met-42")).toBe(true);
		expect(onlyUpdates([{ oldOid: OLD, newOid: NEW, ref: "refs/heads/main" }], "met-42")).toBe(false);
		expect(
			onlyUpdates(
				[
					{ oldOid: OLD, newOid: NEW, ref: "refs/heads/met-42" },
					{ oldOid: OLD, newOid: NEW, ref: "refs/heads/main" },
				],
				"met-42",
			),
		).toBe(false);
	});

	it("refuses deleting the branch and empty pushes", () => {
		expect(onlyUpdates([{ oldOid: OLD, newOid: ZERO, ref: "refs/heads/met-42" }], "met-42")).toBe(false);
		expect(onlyUpdates([], "met-42")).toBe(false);
	});
});
