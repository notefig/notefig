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

/** The body as text, or undefined when it is larger than `maxBytes`. */
export async function readBody(request: Request, maxBytes: number): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return undefined;
  const text = await request.text();
  return new TextEncoder().encode(text).byteLength > maxBytes ? undefined : text;
}
