/**
 * What a harness offers, as its sessions report it (MET-221): a session's
 * settings outlive it on its harness's row, so a picker can show them
 * before the next session exists; its commands stay with the session,
 * since they may be its workspace's own skills (MET-223). Mock mode never
 * probes, so everything here comes from the session.
 *
 *   npx playwright test --project=agent tests/agent/harness-catalog.spec.ts
 */
import { test, expect, type Page } from "@playwright/test";
import { setupTestDatabase } from "../setup/test-helpers";
import { startMockSession } from "./agent-helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const modelOption = {
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue: "opus",
  options: [
    { value: "opus", name: "Opus" },
    { value: "sonnet", name: "Sonnet" },
  ],
};

const commands = [{ name: "review", description: "Review the branch" }];

/** The one session's harness, its catalog, and the commands on its row. */
function sessionState(page: Page) {
  return page.evaluate(() => {
    const core = (window as any).__notefigCore;
    const task = core.agentStore.tasks.toArray[0];
    if (!task) return null;
    const catalog = core.harnesses.collection.get(task.harnessId)?.catalog;
    return {
      harnessId: task.harnessId as string,
      taskCommands: task.commands ?? null,
      models: catalog?.configOptions?.[0]?.options?.map((o: any) => o.value) ?? null,
      catalogCommands: catalog?.commands ?? null,
    };
  });
}

function catalogOf(page: Page, harnessId: string) {
  return page.evaluate((harnessId) => {
    const core = (window as any).__notefigCore;
    return core.harnesses.ready().then(() => {
      const catalog = core.harnesses.collection.get(harnessId)?.catalog;
      return catalog?.configOptions?.[0]?.options?.map((o: any) => o.value) ?? null;
    });
  }, harnessId);
}

test("a session's settings outlive it on its harness; its commands stay with it", async ({
  page,
}) => {
  await setupTestDatabase(page, "harness-catalog");
  await startMockSession(
    page,
    "/workspace/harness-catalog",
    { configOptions: [modelOption] },
    commands,
  );

  await expect.poll(() => sessionState(page)).toMatchObject({
    taskCommands: commands,
    models: ["opus", "sonnet"],
    catalogCommands: null,
  });
  const { harnessId } = (await sessionState(page))!;

  // Nothing in this page's memory has seen the report: the models come
  // back off the harness's persisted row as soon as the rows load. The
  // write lands in the OPFS worker a beat after memory has it.
  await page.waitForTimeout(1000);
  await page.reload();
  expect(await catalogOf(page, harnessId)).toEqual(["opus", "sonnet"]);

  // The chat tab revives the session, and this time the mock reports no
  // settings at all: an empty report never replaces a known list.
  await expect
    .poll(() => page.evaluate(() => (window as any).__notefigCore.agentStore.tasks.toArray[0]?.status))
    .toBe("idle");
  expect(await catalogOf(page, harnessId)).toEqual(["opus", "sonnet"]);
});

test("a later session's settings replace an earlier one's", async ({ page }) => {
  await setupTestDatabase(page, "harness-catalog-latest");
  await startMockSession(page, "/workspace/harness-catalog-latest", {
    configOptions: [modelOption],
  });
  await expect.poll(async () => (await sessionState(page))?.models).toEqual([
    "opus",
    "sonnet",
  ]);
  const { harnessId } = (await sessionState(page))!;

  await page.evaluate(
    (option) =>
      (window as any).__mockAgent.configure({
        scenario: "echo",
        session: { configOptions: [option] },
      }),
    { ...modelOption, currentValue: "haiku", options: [{ value: "haiku", name: "Haiku" }] },
  );
  await page.getByRole("button", { name: /New session with/ }).first().click();

  await expect.poll(() => catalogOf(page, harnessId)).toEqual(["haiku"]);
});
