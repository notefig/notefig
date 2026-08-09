import { useMemo } from "react";
import { platformAdapter } from "@/adapters";

interface CacheEntry {
  promise: Promise<string>;
  status: "pending" | "fulfilled" | "rejected";
  value?: string;
  error?: unknown;
}

const cache = new Map<string, CacheEntry>();

function createCacheKey(imagePath: string, basePath: string): string {
  return `${basePath}:${imagePath}`;
}

function loadImageUrl(imagePath: string, basePath: string): CacheEntry {
  const cacheKey = createCacheKey(imagePath, basePath);

  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  // Remote URLs - resolve synchronously
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    const entry: CacheEntry = {
      promise: Promise.resolve(imagePath),
      status: "fulfilled",
      value: imagePath,
    };
    cache.set(cacheKey, entry);
    return entry;
  }

  // Local paths - async resolution
  const promise = platformAdapter.fs
    .resolveAssetUrl(imagePath, basePath)
    .then((url) => {
      const entry = cache.get(cacheKey);
      if (entry) {
        entry.status = "fulfilled";
        entry.value = url;
      }
      return url;
    })
    .catch((err) => {
      const entry = cache.get(cacheKey);
      if (entry) {
        entry.status = "rejected";
        entry.error = err;
      }
      throw err;
    });

  const entry: CacheEntry = {
    promise,
    status: "pending",
  };

  cache.set(cacheKey, entry);
  return entry;
}

/**
 * Hook to get image URL with Suspense support.
 *
 * This hook implements the Suspense pattern by throwing a promise while loading.
 * The promise is cached indefinitely to prevent infinite re-renders.
 *
 * Usage with Suspense:
 * ```tsx
 * <Suspense fallback={<Loading />}>
 *   <ImageComponent />
 * </Suspense>
 *
 * function ImageComponent() {
 *   const url = useImageUrl(file.path, basePath);
 *   return <img src={url} />;
 * }
 * ```
 *
 * @param imagePath - The image file path or URL
 * @param basePath - The workspace base path
 * @returns The resolved image URL
 * @throws Promise while loading (for Suspense to catch)
 */
export function useImageUrl(imagePath: string, basePath: string): string {
  const entry = useMemo(
    () => loadImageUrl(imagePath, basePath),
    [imagePath, basePath],
  );

  if (entry.status === "fulfilled") {
    return entry.value!;
  }

  if (entry.status === "rejected") {
    throw entry.error;
  }

  // Still pending - throw the promise for Suspense
  throw entry.promise;
}

/**
 * Preload an image URL into the cache.
 * Call this before rendering to avoid Suspense.
 */
export function preloadImageUrl(imagePath: string, basePath: string): void {
  loadImageUrl(imagePath, basePath);
}
