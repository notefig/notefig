import { test } from "@playwright/test";
import { openDemo, shot, DEMO_FILES } from "./helpers";

// The editor rendering gaps (lists, markers, checkboxes, code, quotes, RTL).
// The GPUI side opens the same document (GAPS) in a scratch workspace; in
// the "rtl" one, metrists.json sets `{"settings":{"direction":"rtl"}}`.
export const GAPS = "# Gaps\n\nA paragraph with **bold text** and *italic* in it.\n\n- First bullet\n- Second bullet with **bold**\n\n1. First number\n2. Second number\n\n- [ ] Open task\n- [x] Done task\n\n```ts\nconst answer = 42;\nfunction f() { return answer; }\n```\n\n> A multi-line quote that runs long enough to wrap onto a second line, so the continuation line shows whether it is indented or not at all.\n\n- مورد اول فهرست\n- مورد دوم فهرست\n\n1. شماره یک\n2. شماره دو\n";

for (const dir of ["ltr", "rtl"]) {
  test("editor-gaps-" + dir, async ({ page }) => {
    await page.goto("/");
    const files = [...DEMO_FILES, { path: "/ref-ws/gaps.md", type: "file" as const, content: GAPS }];
    if (dir === "rtl") files.push({ path: "/ref-ws/metrists.json", type: "file" as const, content: JSON.stringify({ settings: { direction: "rtl" } }) });
    await openDemo(page, files);
    await page.getByRole("treeitem", { name: "gaps.md" }).click();
    await shot(page, "editor-gaps-" + dir + "-01");
    await page.mouse.move(900, 600);
    await page.mouse.wheel(0, 500);
    await shot(page, "editor-gaps-" + dir + "-02-scrolled");
  });
}
