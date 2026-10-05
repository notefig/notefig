/**
 * The platform, for components: the adapter core was handed at the root
 * (`core.use("platform")`). Nothing outside the composition root imports
 * `@/adapters` itself.
 */
import { useCore } from "@notefig/core/react";
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";

export function usePlatform(): IPlatformAdapter {
  return useCore().use("platform");
}
