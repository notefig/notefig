import { test, expect } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, waitForFileTree } from "../setup/test-helpers";

/**
 * An idle workspace must stop talking to the backend.
 *
 * Written while chasing a report of `db_execute` calls streaming in the
 * network tab. It did NOT reproduce that (see below), so read it as what it
 * is: a standing guard on a property the app should have anyway, not a
 * regression pin. Every backend call in shim mode is a real HTTP request, so
 * this is the cheapest place we can assert quiescence at all.
 *
 * Three consecutive windows rather than one, because the first seconds after
 * a workspace opens are legitimately busy (collection preloads, task
 * reconciliation, watcher registration) and a single window straddling that
 * tail is flaky — an early version of this test failed at 84 calls for
 * exactly that reason. A decaying tail is boot finishing; a flat non-zero
 * line is a loop.
 *
 * Scope worth knowing when this fails: the document here is empty, so its
 * prompt widget is UNBOUND. A widget carrying a persisted `task=` marker
 * runs a session-reachability effect this test never exercises.
 */
test.describe("shim: idle quiescence", () => {
  let workspace = "";

  test.beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "notefig-idle-"));
    // An empty document: the keeper mounts a prompt widget in it.
    await fs.writeFile(path.join(workspace, "note.md"), "");
  });

  test.afterEach(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  test("an open workspace stops calling the backend once it settles", async ({
    page,
  }) => {
    test.setTimeout(90000);

    const calls: string[] = [];
    await page.route("**/invoke/**", async (route) => {
      calls.push(new URL(route.request().url()).pathname);
      await route.fallback();
    });

    await openWorkspace(page, workspace);
    await waitForFileTree(page, "note.md");
    await page.waitForTimeout(4000);

    const windows: { calls: number; byCommand: Record<string, number> }[] = [];
    for (let i = 0; i < 3; i++) {
      const mark = calls.length;
      await page.waitForTimeout(5000);
      windows.push({
        calls: calls.length - mark,
        byCommand: calls
          .slice(mark)
          .reduce<Record<string, number>>(
            (counts, name) => ({ ...counts, [name]: (counts[name] ?? 0) + 1 }),
            {},
          ),
      });
    }

    // The last window is the verdict: by then any boot tail has drained.
    // Generous on purpose — this needs to separate "quiet" from "spinning",
    // not police a couple of watcher polls.
    expect(
      windows[windows.length - 1].calls,
      `idle backend calls per 5s window: ${JSON.stringify(windows)}`,
    ).toBeLessThan(25);
  });
});
