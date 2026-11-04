import { test } from "@playwright/test";
import { openDemo, shot } from "./helpers";

// The Git tab with checkpoints, and Settings → Usage with a month of
// usage announced through the agent hooks (as the agent runtime does).
test("git", async ({ page }) => {
  await openDemo(page);
  await page.getByRole("button", { name: "Git", exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Initialize commit history" }).click();
  await page.waitForTimeout(800);
  const commit = async (message: string, content: string) => {
    // The web build's IndexedDB adapter cannot commit (isomorphic-git
    // fails with `lstat '.'`), so this is best-effort: the Git tab then
    // shows its post-initialize state.
    await page.evaluate(
      async ({ message, content }) => {
        const core = (window as any).__notefigCore;
        const ws = core.workspace("/ref-ws");
        await ws.files.file("/ref-ws/notes/ideas.md").write(content);
        await ws.history.checkpoint(message, { name: "claude-code", email: "agent@notefig.local" }).catch(() => {});
      },
      { message, content },
    );
    await page.waitForTimeout(400);
  };
  await commit("Initial notes", "# Ideas\n\n- one\n");
  await commit("Add a getting started guide for new users of the workspace", "# Ideas\n\n- one\n- two\n");
  await commit("Expand the README", "# Ideas\n\n- one\n- two\n- three\n");
  await page.evaluate(async () => {
    const ws = (window as any).__notefigCore.workspace("/ref-ws");
    await ws.files.file("/ref-ws/notes/ideas.md").write("# Ideas\n\nuncommitted\n");
  });
  await page.waitForTimeout(800);
  await shot(page, "git-01-checkpoints");
  await page.getByRole("button", { name: "Save commit with description" }).first().click();
  await page.keyboard.type("Tidy the docs");
  await shot(page, "git-03-describe");
  await page.keyboard.press("Escape");

  // A month of usage, announced as the agent runtime does.
  await page.evaluate(() => {
    const core = (window as any).__notefigCore;
    const now = Date.now();
    const hour = 3_600_000;
    let x = 7;
    const rand = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return (x % 1000) / 1000;
    };
    const usd = (a: number) => ({ amount: a, currency: "USD", type: "currency" });
    const turn = (input: number, output: number, read: number, cost: any, models: [string, number][]) => {
      const tokens = { input, output, cacheRead: read, cacheWrite: input * 0.1, thought: 0 };
      return {
        total: { tokens, cost },
        byModel: models.map(([m, s], i) => ({
          model: m,
          usage: {
            tokens: { input: input * s, output: output * s, cacheRead: read * s, cacheWrite: input * 0.1 * s, thought: 0 },
            cost: i === 0 ? cost : null,
          },
        })),
      };
    };
    for (let day = 0; day < 30; day++) {
      for (const h of [9, 10, 11, 14, 15, 16, 17, 21]) {
        const at = now - day * 24 * hour - (now % (24 * hour)) + h * hour;
        if (at > now || rand() < 0.35) continue;
        const w = 1 + Math.abs(Math.sin(day / 6)) * 2;
        const emit = (harnessId: string, usage: any) =>
          core.hooks.emit("agent:usage", { taskId: "task", turnId: "trn", workspacePath: "/ref-ws", harnessId, at, usage });
        const r = rand();
        emit("claude-code", turn(20000 * w * r, 4000 * w, 120000 * w * r, usd(0.4 * w * r), [["claude-sonnet-4-5", 0.7], ["claude-haiku-4-5", 0.3]]));
        if (rand() < 0.6) emit("opencode", turn(15000 * w, 3000, 40000 * rand(), usd(0.2 * w), [["gpt-5", 1]]));
        if (rand() < 0.3) emit("devin", turn(8000, 2000, 0, { amount: 2, currency: "devin-credit", type: "credits" }, []));
      }
    }
    core.hooks.emit("agent:usage-limits", {
      taskId: "task",
      harnessId: "claude-code",
      at: now,
      limits: {
        status: "ok",
        windows: [
          { id: "five_hour", utilization: 0.42, resetsAt: now + 2 * hour + 14 * 60000, durationMs: 5 * hour },
          { id: "seven_day", utilization: 0.78, resetsAt: now + 3 * 24 * hour + 5 * hour, durationMs: 7 * 24 * hour },
        ],
        usingOverage: false,
      },
    });
  });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "Usage", exact: true }).first().click().catch(() => {});
  await page.waitForTimeout(1000);
  await shot(page, "usage-01-all");
  await page.getByTestId("usage-settings").screenshot({ path: __dirname + "/out/usage-01-section.png" }).catch(() => {});
  await page.getByTestId("usage-harness-select").click();
  await page.waitForTimeout(300);
  await shot(page, "usage-02-picker");
  await page.getByRole("menuitem", { name: /Claude/ }).first().click();
  await page.waitForTimeout(800);
  await page.getByTestId("usage-settings").screenshot({ path: __dirname + "/out/usage-03-claude.png" }).catch(() => {});
});
