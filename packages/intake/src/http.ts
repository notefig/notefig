import type { HttpResult } from "./submit";

/** CORS headers for an allowed `Origin`, or undefined for any other. */
export function corsHeaders(
  request: Request,
  allowedOrigins: string,
): Record<string, string> | undefined {
  const origin = request.headers.get("origin");
  if (!origin) return undefined;
  const allowed = allowedOrigins.split(",").map((entry) => entry.trim());
  if (!allowed.includes(origin)) return undefined;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export function toResponse(result: HttpResult, headers?: Record<string, string>): Response {
  return Response.json(result.body, { status: result.status, headers });
}

/**
 * The body as text, or undefined when it is larger than `maxBytes`. Reads
 * the stream and stops as soon as it passes the limit, so an oversized or
 * unlabelled body is never buffered whole.
 */
export async function readBody(request: Request, maxBytes: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return undefined;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
