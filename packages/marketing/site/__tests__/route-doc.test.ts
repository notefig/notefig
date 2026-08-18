import { describe, expect, it } from "vitest";
import { defaultDoc, findDoc } from "../content-manifest";
import { LANDING_TITLE, docForPathname, titleForRoute } from "../route-doc";

describe("docForPathname", () => {
  it("opens the introduction on the landing page and on /docs", () => {
    expect(docForPathname("/")).toBe(defaultDoc);
    expect(docForPathname("/docs")).toBe(defaultDoc);
    expect(docForPathname("/docs/")).toBe(defaultDoc);
  });

  it("opens the page a deep link names", () => {
    expect(docForPathname("/docs/cli")).toBe(findDoc("cli"));
  });

  it("rejects paths that are not pages of this site", () => {
    expect(docForPathname("/docs/nope")).toBeNull();
    expect(docForPathname("/pricing")).toBeNull();
    expect(docForPathname("/docs/cli/extra")).toBeNull();
  });
});

describe("titleForRoute", () => {
  it("pitches on the landing page and names the page on a deep link", () => {
    const cli = findDoc("cli")!;
    expect(titleForRoute(cli, false)).toBe(LANDING_TITLE);
    expect(titleForRoute(cli, true)).toBe("CLI — Notefig Docs");
  });
});
