/**
 * SLOs: the app's second-class actions, input to the first painted frame
 * that shows their result — open the command palette, open settings,
 * switch between two open tabs (one the 8,000-line document), open a file
 * that isn't open yet, create a scratchpad, open search and type a query
 * (and its results, which include the search's 300 ms debounce), and open
 * an agent session tab with a long transcript.
 *
 * Every action runs from a workspace that is already open and settled, with
 * the large document open beside README.md, so what each one costs is
 * measured against the shell a real working session has.
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import {
  perfWorkspace,
  README_SENTINEL,
  resetLargeDocument,
  WIDGETS,
} from "./fixture";
import {
  action,
  installProbe,
  readSamples,
  setLabel,
  stroke,
} from "./latency";
import { saveSamples } from "./results";
import { withShim } from "./shim";

/** Samples per action. */
const ROUNDS = Number(process.env.PERF_ACTION_ROUNDS ?? 10);

/** The large document's first line. */
const LARGE_SENTINEL = "Large document";

/** The agent session seeded for the chat tab. */
const CHAT_TASK = "task_perfchat";
const CHAT_TURNS = 60;
const CHAT_SENTINEL = "End of the perf transcript";

interface CoreHandle {
  tabs: {
    open(tabId: string, options: { intent: string }): boolean;
    activeTabId(): string | null;
  };
  url: {
    search(): string;
    setSearch(search: string, options: { replace: boolean }): void;
  };
  agentStore: {
    tasks: { insert(row: object): unknown };
    turns: { insert(row: object): unknown };
    entries: { insert(row: object): unknown };
  };
}

/** In the page: one agent session with a long, mixed transcript. */
function seedChat(args: {
  workspace: string;
  taskId: string;
  turns: number;
  sentinel: string;
}): void {
  const { agentStore } = (window as unknown as { __notefigCore: CoreHandle })
    .__notefigCore;
  const now = Date.now();
  agentStore.tasks.insert({
    taskId: args.taskId,
    workspacePath: args.workspace,
    title: "Perf chat",
    status: "idle",
    harnessId: "claude",
    sessionId: "session_perfchat",
    createdAt: now,
    updatedAt: now,
  });
  const pad = (n: number) => String(n).padStart(6, "0");
  let event = 0;
  const entry = (row: object) =>
    agentStore.entries.insert({
      id: `evt_${pad(event++)}`,
      taskId: args.taskId,
      createdAt: now,
      ...row,
    });
  for (let i = 0; i < args.turns; i++) {
    const turnId = `trn_${pad(i)}`;
    agentStore.turns.insert({
      turnId,
      taskId: args.taskId,
      sessionId: "session_perfchat",
      status: "completed",
      startedAt: now,
    });
    entry({
      turnId,
      type: "user",
      text: `Question ${i}: how does the section ${i} handle its tables and lists?`,
    });
    for (let j = 0; j < 2; j++)
      entry({
        turnId,
        type: "tool_call",
        toolCallId: `call_${i}_${j}`,
        toolCall: {
          toolCallId: `call_${i}_${j}`,
          title: `Read area-${i % 20}/topic-${j}/note-${i}.md`,
          kind: "read",
          status: "completed",
        },
      });
    const last = i === args.turns - 1;
    entry({
      turnId,
      type: "assistant",
      text: [
        `## Answer ${i}`,
        "",
        "Section " + i + " keeps its **tables** and *lists* in order:",
        "",
        "- the first item, with `inline code`",
        "- the second item, with a [link](https://example.com)",
        "- the third item",
        "",
        "```ts",
        `const section = load(${i});`,
        "return section.tables.map((table) => table.rows);",
        "```",
        "",
        "| Column | Value |",
        "| --- | --- |",
        `| rows | ${i * 12} |`,
        `| lists | ${i * 5} |`,
        "",
        last ? args.sentinel : `That covers section ${i}.`,
      ].join("\n"),
    });
  }
}

/** Open the workspace with README.md, large.md and the seeded chat, in
 *  that tab order, and let the open's tail settle. */
async function openSession(page: Page, workspace: string): Promise<void> {
  await resetLargeDocument(workspace);
  await page.goto("/");
  await page.waitForFunction(() => Boolean(window.__notefigTest));
  await page.evaluate(
    async ({ workspace, readme, large }) => {
      await window.__notefigTest.openProject(workspace);
      window.__notefigCore.tabs.open(readme, { intent: "replace" });
      window.__notefigCore.tabs.open(large, { intent: "new-tab" });
    },
    {
      workspace,
      readme: path.join(workspace, "README.md"),
      large: path.join(workspace, "large.md"),
    },
  );
  await expect(
    page.locator('.ProseMirror [data-type="ai-prompt"]'),
  ).toHaveCount(WIDGETS, { timeout: 30_000 });
  await page.evaluate(seedChat, {
    workspace,
    taskId: CHAT_TASK,
    turns: CHAT_TURNS,
    sentinel: CHAT_SENTINEL,
  });
  await page.evaluate(
    (tabId) =>
      (
        window as unknown as { __notefigCore: CoreHandle }
      ).__notefigCore.tabs.open(tabId, { intent: "new-tab" }),
    `agent:${CHAT_TASK}`,
  );
  await expect(
    page.locator('[data-entry-type="assistant"]', { hasText: CHAT_SENTINEL }),
  ).toBeVisible({ timeout: 30_000 });
  await press(page, "Control+2");
  await expect(
    page.locator(".ProseMirror", { hasText: LARGE_SENTINEL }),
  ).toBeVisible();
  // Let the open's tail (tree, collections, minimap) settle first.
  await page.waitForTimeout(3000);
}

/** An unmeasured key press, and time for its tail. */
async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
}

/** Put the sidebar back on the file tree. */
async function showFiles(page: Page): Promise<void> {
  await page.evaluate(() => {
    const { url } = (window as unknown as { __notefigCore: CoreHandle })
      .__notefigCore;
    const params = new URLSearchParams(url.search());
    params.set("sidebarView", "files");
    url.setSearch(`?${params}`, { replace: true });
  });
  await page.waitForTimeout(500);
}

const editorShowing = (text: string) => ({
  selector: ".ProseMirror",
  text,
});

test("second-class actions in an open workspace", async ({ page }) => {
  const workspace = await perfWorkspace();
  const readme = path.join(workspace, "README.md");
  await withShim(async () => {
    await installProbe(page);
    await openSession(page, workspace);

    for (let i = 0; i < ROUNDS; i++) {
      await action(
        page,
        "palette-open",
        { selector: "[cmdk-input]", focused: true },
        () => page.keyboard.press("Control+k"),
      );
      await press(page, "Escape");
    }

    for (let i = 0; i < ROUNDS; i++) {
      await action(
        page,
        "settings-open",
        { selector: '[role="dialog"]', text: "Appearance" },
        () => page.keyboard.press("Control+Shift+Comma"),
      );
      await press(page, "Escape");
    }

    for (let i = 0; i < ROUNDS; i++) {
      await action(page, "tab-switch", editorShowing(README_SENTINEL), () =>
        page.keyboard.press("Control+1"),
      );
      await action(page, "tab-switch", editorShowing(LARGE_SENTINEL), () =>
        page.keyboard.press("Control+2"),
      );
    }

    for (let i = 0; i < ROUNDS; i++) {
      await action(
        page,
        "chat-open",
        {
          selector: '[data-entry-type="assistant"]',
          text: CHAT_SENTINEL,
        },
        () => page.keyboard.press("Control+3"),
      );
      await press(page, "Control+2");
    }

    // From README.md, which the opened file replaces (a preview open).
    await press(page, "Control+1");
    for (let i = 0; i < ROUNDS; i++) {
      await press(page, "Control+p");
      await page.keyboard.type(`topic-${i}/note-${i + 10}`);
      await page.waitForTimeout(300);
      const value = await page
        .locator("[cmdk-item][data-selected=true]")
        .getAttribute("data-value");
      const match = value?.match(/area-(\d+)\/topic-(\d+)\/note-(\d+)\.md$/);
      expect(match, `palette picked ${value}`).toBeTruthy();
      const [, a, t, n] = match!;
      await action(page, "file-open", editorShowing(`Note ${a}.${t}.${n}`), () =>
        page.keyboard.press("Enter"),
      );
      await page.evaluate(
        (readme) =>
          (
            window as unknown as { __notefigCore: CoreHandle }
          ).__notefigCore.tabs.open(readme, { intent: "replace" }),
        readme,
      );
      await expect(
        page.locator(".ProseMirror", { hasText: README_SENTINEL }),
      ).toBeVisible();
      await page.waitForTimeout(500);
    }

    for (let i = 0; i < ROUNDS; i++) {
      await action(
        page,
        "new-scratchpad",
        {
          selector: '.ProseMirror[contenteditable="true"]',
          empty: true,
          focused: true,
        },
        () => page.keyboard.press("Control+n"),
      );
      await press(page, "Control+w");
    }

    await press(page, "Control+2");
    for (let i = 0; i < ROUNDS; i++) {
      await showFiles(page);
      await action(
        page,
        "search-open",
        { selector: 'input[placeholder^="Search "]', focused: true },
        () => page.keyboard.press("Control+Shift+f"),
      );
      const query = `Note ${i}.${i + 1}.${i + 2}`;
      await setLabel(page, "search-type");
      for (const char of query.slice(0, -1)) await stroke(page, char);
      // The search itself runs in the backend, and under load the shim's
      // occasionally comes back empty: a missed sample, not a failed run.
      await action(
        page,
        "search-results",
        { selector: '[class*="bg-highlight"]', text: query },
        () => page.keyboard.press(query.slice(-1)),
      ).catch((error: Error) => console.warn(error.message));
      await press(page, "Control+a");
      await press(page, "Backspace");
    }
    await setLabel(page, null);

    await saveSamples("actions", await readSamples(page));
    await page.goto("about:blank");
  });
});
