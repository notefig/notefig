/**
 * Reads the bundled dictation model (`public/dictation/`, written by
 * scripts/fetch-dictation-model.mjs) from the app's own origin: the manifest,
 * then every chunk, each checked against its size and sha256 before the
 * bytes are joined. The check matters beyond corruption: the web build's SPA
 * fallback answers a missing file with index.html and a 200.
 */

export interface ModelManifest {
  version: string;
  size: number;
  chunks: { file: string; size: number; sha256: string }[];
  tokens: { file: string; sha256: string };
}

export interface BundledModel {
  version: string;
  bytes: Uint8Array;
  tokens: string;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchChecked(
  fetcher: typeof fetch,
  url: URL,
  expected: { size?: number; sha256: string },
): Promise<Uint8Array> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`dictation model: ${response.status} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (expected.size !== undefined && bytes.length !== expected.size) {
    throw new Error(`dictation model: ${url} is ${bytes.length} bytes, expected ${expected.size}`);
  }
  if ((await sha256Hex(bytes)) !== expected.sha256) {
    throw new Error(`dictation model: checksum mismatch for ${url}`);
  }
  return bytes;
}

export async function loadBundledModel(
  baseUrl: URL,
  fetcher: typeof fetch = fetch,
): Promise<BundledModel> {
  const manifestResponse = await fetcher(new URL("manifest.json", baseUrl));
  if (!manifestResponse.ok) {
    throw new Error(`dictation model: no manifest (${manifestResponse.status})`);
  }
  const manifest = (await manifestResponse.json()) as ModelManifest;
  const [tokens, ...chunks] = await Promise.all([
    fetchChecked(fetcher, new URL(manifest.tokens.file, baseUrl), manifest.tokens),
    ...manifest.chunks.map((c) => fetchChecked(fetcher, new URL(c.file, baseUrl), c)),
  ]);
  const bytes = new Uint8Array(manifest.size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== manifest.size) {
    throw new Error(`dictation model: chunks add up to ${offset} bytes, expected ${manifest.size}`);
  }
  return { version: manifest.version, bytes, tokens: new TextDecoder().decode(tokens) };
}
