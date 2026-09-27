import {
  defaultPage,
  findPageByRoute,
  type MarketingPage,
} from "./content-manifest";

export const LANDING_TITLE = "Notefig | The open-source AI metaharness";

/**
 * Which page a URL shows. `/` opens the introduction; the site's other
 * pages sit at the path their file has in the content tree (`/download`).
 * `/docs` stays an alias for the introduction. Anything else, the other docs
 * included (they are editor demo content now), is not a page of this site
 * (null → `/`).
 */
export function pageForPathname(pathname: string): MarketingPage | null {
  const route = `/${pathname.split("/").filter(Boolean).join("/")}`;
  if (route === "/" || route === "/docs") return defaultPage;
  return findPageByRoute(route) ?? null;
}

/** The tab title for a URL: the landing pitch on `/`, the page elsewhere. */
export function titleForRoute(page: MarketingPage, isDeepLink: boolean): string {
  return isDeepLink ? `${page.title} | Notefig` : LANDING_TITLE;
}
