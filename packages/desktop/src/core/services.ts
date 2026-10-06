/**
 * What the root hands every module, as modules: a module lists
 * `platformModule` in `needs` like any other, and core hands it the value
 * the composition root (`app-core.ts`) provides under that name.
 */
import { defineService } from "@notefig/core";
import type { QueryClient } from "@tanstack/react-query";
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import type { UrlState } from "@/modules/layout";

declare module "@notefig/core" {
  interface CoreServices {
    platform: IPlatformAdapter;
    queryClient: QueryClient;
    /** The root's router. */
    url: UrlState;
  }
}

/** The platform adapter: fs, db, processes, UI. */
export const platformModule = defineService("platform");
/** The app-wide query client. */
export const queryClientModule = defineService("queryClient");
/** The root's router, seen through `UrlState`. */
export const urlModule = defineService("url");
