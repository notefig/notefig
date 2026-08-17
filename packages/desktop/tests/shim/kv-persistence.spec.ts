import { test, expect } from "@playwright/test";

/**
 * MET-124 — product KV over the real Rust backend.
 *
 * This is coverage that did not previously exist at any level. Before the
 * cutover, KV rode `@tauri-apps/plugin-store`, whose `plugin:store|*` traffic
 * `shim-transport.ts` resolves to `null` — so every settings write in every e2e
 * run was silently a no-op, and no test anywhere proved a setting survived a
 * reload. It now goes through `db_execute`/`db_query` to real rusqlite, and this
 * asserts that end to end.
 *
 * The unit tests cover the same module against in-process SQLite; what only a
 * real process can show is the round trip across IPC and a page reload.
 */

const NS = "settings";

const SHIM_PORT = Number(process.env.SHIM_PORT ?? 4599);

/**
 * Fresh database per test. Without this, a `lastPath` persisted by an earlier
 * spec's workspace visit makes `goto("/")` restore that workspace, whose
 * collections then transact on the shim's shared SQLite connection
 * concurrently with this spec's writes ("cannot start a transaction within a
 * transaction").
 */
async function dbReset() {
  const res = await fetch(
    `http://127.0.0.1:${SHIM_PORT}/invoke/db_reset`,
    { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" },
  );
  if (!res.ok) throw new Error(`db_reset failed (${res.status})`);
}

/** Drives the app's own kv-store module, not a probe collection. */
const writeSettings = `
  (async () => {
    const kv = await import('/src/utils/kv-store.ts');
    await kv.writeKv('${NS}', 'theme', 'light');
    await kv.writeKv('${NS}', 'zoomLevel', 1.25);
    await kv.writeKv('${NS}', 'recent', { name: 'notes', lastOpenedAt: 17 });
    return kv.readAllKv('${NS}');
  })()
`;

const readSettings = `
  (async () => {
    const kv = await import('/src/utils/kv-store.ts');
    return kv.readAllKv('${NS}');
  })()
`;

test.describe("shim: KV persistence over the real transport", () => {
  test.beforeEach(dbReset);

  test("settings written from the page survive a reload", async ({ page }) => {
    await page.goto("/");

    const written = await page.evaluate(writeSettings);
    expect(written).toMatchObject({
      theme: "light",
      zoomLevel: 1.25,
      recent: { name: "notes", lastOpenedAt: 17 },
    });

    await page.reload();

    // Nothing in this page's memory has ever seen these values, so anything it
    // reports came back out of the SQLite file the Rust side owns — including
    // the structured value, which has to survive JSON round-tripping through
    // two process boundaries.
    const restored = await page.evaluate(readSettings);
    expect(restored).toMatchObject({
      theme: "light",
      zoomLevel: 1.25,
      recent: { name: "notes", lastOpenedAt: 17 },
    });
  });

  test("a removed setting stays removed across a reload", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(`
      (async () => {
        const kv = await import('/src/utils/kv-store.ts');
        await kv.writeKv('${NS}', 'doomed', 'value');
        await kv.removeKv('${NS}', 'doomed');
      })()
    `);

    await page.reload();

    // A delete that only cleared memory would let the row reappear here — the
    // failure mode a write-through store hides until the next launch.
    const value = await page.evaluate(`
      import('/src/utils/kv-store.ts').then((kv) => kv.readKv('${NS}', 'doomed'))
    `);
    expect(value).toBeUndefined();
  });

  test("namespaces stay separate in storage, not just in memory", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(`
      (async () => {
        const kv = await import('/src/utils/kv-store.ts');
        await kv.writeKv('${NS}', 'shared', 'from settings');
        await kv.writeKv('recentProjects', 'shared', 'from projects');
      })()
    `);

    await page.reload();

    const [settings, projects] = (await page.evaluate(`
      import('/src/utils/kv-store.ts').then((kv) => Promise.all([
        kv.readKv('${NS}', 'shared'),
        kv.readKv('recentProjects', 'shared'),
      ]))
    `)) as [string, string];
    expect(settings).toBe("from settings");
    expect(projects).toBe("from projects");
  });
});
