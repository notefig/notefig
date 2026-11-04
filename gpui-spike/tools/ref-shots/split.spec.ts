import { test } from "@playwright/test";
import { openDemo, shot } from "./helpers";

// A two-window split, built through the layout URL param (`?layout=`):
// README.md on the left, ideas.md on the right, as the GPUI split shot.
test("split", async ({ page }) => {
  await page.goto("/");
  await openDemo(page);
  await page.getByRole("treeitem", { name: "README.md" }).click();
  await page.waitForTimeout(500);
  const layout = [
    {
      type: "Panel",
      id: "panel-root",
      orientation: "row",
      size: 1,
      children: [
        { type: "Window", id: "left", children: ["/ref-ws/README.md"], selected: "/ref-ws/README.md", size: 0.5 },
        { type: "Window", id: "right", children: ["/ref-ws/notes/ideas.md"], selected: "/ref-ws/notes/ideas.md", size: 0.5 },
      ],
    },
  ];
  const url = new URL(page.url());
  url.searchParams.set("layout", JSON.stringify(layout));
  await page.goto(url.toString());
  await page.waitForTimeout(1500);
  await shot(page, "split-01-two-windows");
});
