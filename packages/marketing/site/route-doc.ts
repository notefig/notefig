import {
  MARKETING_WORKSPACE,
  defaultDoc,
  findDoc,
  type MarketingDoc,
} from "./content-manifest";

export const LANDING_TITLE = "Notefig — Write Markdown. Continuously Publish.";

/**
 * Which doc a URL shows. `/` and `/docs` open the introduction; `/docs/<slug>`
 * opens that page. Anything else is not a page of this site (null → `/`).
 */
export function docForPathname(pathname: string): MarketingDoc | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return defaultDoc;
  if (segments[0] !== MARKETING_WORKSPACE || segments.length > 2) return null;
  return segments.length === 1 ? defaultDoc : (findDoc(segments[1]) ?? null);
}

/** The tab title for a URL: the landing pitch on `/`, the page elsewhere. */
export function titleForRoute(doc: MarketingDoc, isDeepLink: boolean): string {
  return isDeepLink ? `${doc.title} — Notefig Docs` : LANDING_TITLE;
}
