/**
 * Webhook signatures: the hex HMAC-SHA256 of the raw body, as Linear sends it in `Linear-Signature` and GitHub in
 * `X-Hub-Signature-256` (after a `sha256=` prefix). Checked in constant time by WebCrypto.
 */
export async function signedBy(secret: string, body: string, signature: string | null): Promise<boolean> {
	if (!signature) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	const bytes = hexToBytes(signature.replace(/^sha256=/, ""));
	return bytes !== null && crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
}

function hexToBytes(hex: string): Uint8Array | null {
	if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
	return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}
