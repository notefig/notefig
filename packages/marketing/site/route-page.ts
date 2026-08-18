import {
  defaultPage,
  findPageByRoute,
  type MarketingPage,
} from "./content-manifest";

export const LANDING_TITLE = "Notefig — Write Markdown. Continuously Publish.";

/**
 * Which page a URL shows. `/` opens the introduction, every other page is at
 * the path its file sits on in the content tree (`/docs/cli`, `/download`).
 * `/docs` is a convenience alias for the introduction. Anything else is not a
 * page of this site (null → `/`).
 */
export function pageForPathname(pathname: string): MarketingPage | null {
  const route = `/${pathname.split("/").filter(Boolean).join("/")}`;
  if (route === "/" || route === "/docs") return defaultPage;
  return findPageByRoute(route) ?? null;
}

/** The tab title for a URL: the landing pitch on `/`, the page elsewhere. */
export function titleForRoute(page: MarketingPage, isDeepLink: boolean): string {
  return isDeepLink ? `${page.title} — Notefig` : LANDING_TITLE;
}
