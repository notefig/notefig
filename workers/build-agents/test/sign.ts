/** The hex HMAC-SHA256 a webhook sender puts in its signature header. */
export async function sign(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
	return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
