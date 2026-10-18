/** Helpers every support.notefig.com route shares. */

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The request's body, read without buffering more than `maxBytes`: a
 * missing or lying Content-Length can't make the Worker hold a large body.
 * Gives back the error response when it's too large.
 */
export async function readBody(
  request: Request,
  maxBytes: number,
): Promise<{ body: Blob } | { error: Response }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body?.getReader();
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { error: json(413, { error: "Body too large" }) };
    }
    chunks.push(value);
  }
  return { body: new Blob(chunks) };
}

/**
 * CORS headers for a request from one of `allowedOrigins` (the app's
 * webviews and the web app). Any other origin gets none.
 */
export function corsHeaders(
  request: Request,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins.includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
