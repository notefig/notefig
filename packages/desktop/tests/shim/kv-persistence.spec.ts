import { test, expect } from "@playwright/test";
import { resetShimDb } from "../setup/shim-db";

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

/** Drives the app's own KV (`core.kv`), not a probe collection. */
const writeSettings = `
  (async () => {
    const kv = window.__notefigCore.kv;
    await kv.write('${NS}', 'theme', 'light');
    await kv.write('${NS}', 'zoomLevel', 1.25);
    await kv.write('${NS}', 'recent', { name: 'notes', lastOpenedAt: 17 });
    return kv.readAll('${NS}');
  })()
`;

const readSettings = `
  (async () => {
    const kv = window.__notefigCore.kv;
    return kv.readAll('${NS}');
  })()
`;

test.describe("shim: KV persistence over the real transport", () => {
  test.beforeEach(resetShimDb);

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
        const kv = window.__notefigCore.kv;
        await kv.write('${NS}', 'doomed', 'value');
        await kv.remove('${NS}', 'doomed');
      })()
    `);

    await page.reload();

    // A delete that only cleared memory would let the row reappear here — the
    // failure mode a write-through store hides until the next launch.
    const value = await page.evaluate(`
      window.__notefigCore.kv.read('${NS}', 'doomed')
    `);
    expect(value).toBeUndefined();
  });

  test("namespaces stay separate in storage, not just in memory", async ({
    page,
  }) => {
    await page.goto("/");
    await page.evaluate(`
      (async () => {
        const kv = window.__notefigCore.kv;
        await kv.write('${NS}', 'shared', 'from settings');
        await kv.write('recentProjects', 'shared', 'from projects');
      })()
    `);

    await page.reload();

    const [settings, projects] = (await page.evaluate(`
      Promise.all([
        window.__notefigCore.kv.read('${NS}', 'shared'),
        window.__notefigCore.kv.read('recentProjects', 'shared'),
      ])
    `)) as [string, string];
    expect(settings).toBe("from settings");
    expect(projects).toBe("from projects");
  });
});
