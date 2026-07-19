import { QueryClient } from "@tanstack/query-core";

/**
 * The app-wide QueryClient, alone in its own module so every entity module
 * (and anything else) can import it without pulling in another entity's
 * module graph. This file must stay a leaf: zero imports besides
 * @tanstack/query-core.
 *
 * The one deliberate exception to "app-wide": agent-collections.ts keeps its
 * own private QueryClient (see the comment there) — everything else shares
 * this one.
 */
export const queryClient = new QueryClient({
  defaultOptions: {},
});
