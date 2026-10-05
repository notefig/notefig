const SHIM_PORT = Number(process.env.SHIM_PORT ?? 4599);

/**
 * Fresh shim database. Every shim spec talks to one backend, so anything a
 * spec persists outlives it: the saved session URL (`settings.lastSearch`)
 * restores into the next spec's `goto("/")` — its sidebar view, its tabs.
 * A spec that opens the app starts from a clean slate instead of whatever
 * its predecessor left behind.
 */
export async function resetShimDb(): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${SHIM_PORT}/invoke/db_reset`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`db_reset failed (${res.status})`);
}
