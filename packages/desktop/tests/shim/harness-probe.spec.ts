/**
 * MET-221 — a harness's catalog probe over the real backend: the install
 * check and the probe run the harness's own command through the real
 * login shell (`run_shell_command`), and what it finds lands on the
 * harness's persisted row.
 *
 * OpenCode is probed by command (`opencode models`), so a script standing
 * in for it — one that logs each run — is all a real probe needs. Probes
 * by session spawn a harness and talk ACP over its stdout, which the shim
 * doesn't forward yet; their unit tests cover them. No login shell on
 * Windows, so no probe there either.
 */
import { test, expect, type Page } from "@playwright/test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetShimDb } from "../setup/shim-db";

/* eslint-disable @typescript-eslint/no-explicit-any */

test.skip(process.platform === "win32", "no login shell to probe through");

let dir: string;
let script: string;

test.beforeEach(async () => {
  await resetShimDb();
  dir = mkdtempSync(join(tmpdir(), "notefig-probe-e2e-"));
  script = join(dir, "fake-opencode");
  // `models` prints a banner and two models, the first named by its env;
  // every run is logged, and FAKE_FAIL makes it fail.
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `echo "$FAKE_MODEL $*" >> '${join(dir, "runs")}'`,
      '[ "$FAKE_FAIL" = 1 ] && exit 1',
      "echo 'opencode v0 (fake)'",
      'echo "prov/$FAKE_MODEL"',
      "echo prov/other",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
});

test.afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Every run of the fake harness so far. */
function runs(): string[] {
  try {
    return readFileSync(join(dir, "runs"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** OpenCode as the fake script, every other built-in switched off. */
function useFakeOpenCode(page: Page, env: Record<string, string>, enabled = true) {
  return page.evaluate(
    async ({ script, env, enabled }) => {
      const harnesses = (window as any).__notefigCore.harnesses;
      await harnesses.ready();
      for (const definition of harnesses.configured()) {
        if (definition.id !== "opencode") {
          await harnesses.harness(definition.id).setEnabled(false);
        }
      }
      return harnesses.harness("opencode").saveOverride({
        id: "opencode",
        command: script,
        probeCommand: `command -v '${script}'`,
        env,
        enabled,
      });
    },
    { script, env, enabled },
  );
}

/** The model ids OpenCode's catalog holds, once the rows have loaded. */
function models(page: Page): Promise<string[] | null> {
  return page.evaluate(async () => {
    const harnesses = (window as any).__notefigCore.harnesses;
    await harnesses.ready();
    const catalog = harnesses.collection.get("opencode")?.catalog;
    return catalog?.configOptions?.[0]?.options?.map((o: any) => o.value) ?? null;
  });
}

test.describe("shim: a harness's catalog probe", () => {
  // Probes run one at a time, and a session probe of a real harness found
  // on this machine (before the others are switched off) may go first.
  test.describe.configure({ timeout: 120_000 });
  const poll = { timeout: 60_000 };

  test("probes a harness once it's found, and keeps what it found across a relaunch", async ({
    page,
  }) => {
    await page.goto("/");
    expect(await useFakeOpenCode(page, { FAKE_MODEL: "alpha" })).toBe(true);

    await expect.poll(() => models(page), poll).toEqual(["prov/alpha", "prov/other"]);
    expect(runs()).toEqual(["alpha models"]);

    // Fresh findings: the launch's install check finds it again, and
    // nothing runs it. The models come back off the persisted row.
    await page.waitForTimeout(1000);
    await page.reload();
    expect(await models(page)).toEqual(["prov/alpha", "prov/other"]);
    await page.waitForTimeout(5000);
    expect(runs()).toEqual(["alpha models"]);
  });

  test("an edit probes again under the new definition", async ({ page }) => {
    await page.goto("/");
    await useFakeOpenCode(page, { FAKE_MODEL: "alpha" });
    await expect.poll(() => models(page), poll).toEqual(["prov/alpha", "prov/other"]);

    await useFakeOpenCode(page, { FAKE_MODEL: "beta" });

    await expect.poll(() => models(page), poll).toEqual(["prov/beta", "prov/other"]);
    expect(runs()).toEqual(["alpha models", "beta models"]);
  });

  test("a probe that fails keeps the last catalog", async ({ page }) => {
    await page.goto("/");
    await useFakeOpenCode(page, { FAKE_MODEL: "alpha" });
    await expect.poll(() => models(page), poll).toEqual(["prov/alpha", "prov/other"]);

    await useFakeOpenCode(page, { FAKE_MODEL: "gamma", FAKE_FAIL: "1" });

    await expect.poll(runs, poll).toEqual(["alpha models", "gamma models"]);
    await page.waitForTimeout(1000);
    expect(await models(page)).toEqual(["prov/alpha", "prov/other"]);
  });

  test("a harness switched off is never probed", async ({ page }) => {
    await page.goto("/");
    await useFakeOpenCode(page, { FAKE_MODEL: "alpha" }, false);

    await page.waitForTimeout(5000);
    expect(runs()).toEqual([]);
  });
});
