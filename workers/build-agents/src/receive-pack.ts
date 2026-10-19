/**
 * The ref updates a `git push` asks for. A push's `git-receive-pack` request body starts with pkt-lines, one per ref:
 * `<old-oid> <new-oid> <refname>`, the first followed by NUL and capabilities, ended by a flush (`0000`); the pack
 * follows. Only that header is read, so the gateway can refuse a push before any of it reaches GitHub.
 */
export interface RefUpdate {
	oldOid: string;
	newOid: string;
	ref: string;
}

/** The ref updates, or `null` when the header is malformed or longer than `bytes`. */
export function readRefUpdates(bytes: Uint8Array): RefUpdate[] | null {
	const updates: RefUpdate[] = [];
	const text = new TextDecoder("latin1");
	for (let offset = 0; ; ) {
		if (offset + 4 > bytes.length) return null;
		const length = parseInt(text.decode(bytes.subarray(offset, offset + 4)), 16);
		if (Number.isNaN(length)) return null;
		if (length === 0) return updates;
		if (length < 4 || offset + length > bytes.length) return null;
		const line = text.decode(bytes.subarray(offset + 4, offset + length)).split("\0")[0].replace(/\n$/, "");
		const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (\S+)$/.exec(line);
		if (!match) return null;
		updates.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
		offset += length;
	}
}

const ZERO = /^0+$/;

/** A push the agent may make: at least one update, every one to `branch`, none deleting it. */
export function onlyUpdates(updates: readonly RefUpdate[], branch: string): boolean {
	return updates.length > 0 && updates.every((update) => update.ref === `refs/heads/${branch}` && !ZERO.test(update.newOid));
}
