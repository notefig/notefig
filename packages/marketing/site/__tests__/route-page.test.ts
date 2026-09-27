import { describe, expect, it } from "vitest";
import { defaultPage, findPageByRoute } from "../content-manifest";
import { LANDING_TITLE, pageForPathname, titleForRoute } from "../route-page";

describe("pageForPathname", () => {
  it("opens the introduction on the landing page and on /docs", () => {
    expect(pageForPathname("/")).toBe(defaultPage);
    expect(pageForPathname("/docs")).toBe(defaultPage);
    expect(pageForPathname("/docs/")).toBe(defaultPage);
  });

  it("opens the page a deep link names", () => {
    expect(pageForPathname("/download")).toBe(findPageByRoute("/download"));
  });

  it("rejects paths that are not pages of this site, docs included", () => {
    expect(pageForPathname("/docs/cli")).toBeNull();
    expect(pageForPathname("/docs/nope")).toBeNull();
    expect(pageForPathname("/pricing")).toBeNull();
    expect(pageForPathname("/docs/cli/extra")).toBeNull();
  });
});

describe("titleForRoute", () => {
  it("pitches on the landing page and names the page on a deep link", () => {
    const download = findPageByRoute("/download")!;
    expect(titleForRoute(download, false)).toBe(LANDING_TITLE);
    expect(titleForRoute(download, true)).toBe("Download | Notefig");
  });
});
