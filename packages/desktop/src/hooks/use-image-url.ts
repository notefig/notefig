import { useMemo } from "react";
import { platformAdapter } from "@/adapters";
import { path as pathutil } from "@/utils/path";

export interface ResolvedImage {
  /** Displayable URL (asset://, blob:, data:, or the remote URL itself). */
  url: string;
  /** The on-disk path the URL was resolved from (the imagePath for remote URLs). */
  absolutePath: string;
}

interface CacheEntry {
  promise: Promise<ResolvedImage>;
  status: "pending" | "fulfilled" | "rejected";
  value?: ResolvedImage;
  error?: unknown;
}

const cache = new Map<string, CacheEntry>();

function loadImage(imagePath: string, basePaths: string[]): CacheEntry {
  const cacheKey = `${basePaths.join("|")}:${imagePath}`;

  const existing = cache.get(cacheKey);
  if (existing) {
    return existing;
  }

  // Remote URLs - resolve synchronously
  if (imagePath.startsWith("http://") || imagePath.startsWith("https://")) {
    const value = { url: imagePath, absolutePath: imagePath };
    const entry: CacheEntry = {
      promise: Promise.resolve(value),
      status: "fulfilled",
      value,
    };
    cache.set(cacheKey, entry);
    return entry;
  }

  // Local paths — a relative src can be anchored at any of the candidate
  // bases (Obsidian resolves both from the document's directory and from
  // the vault root). Probe in order and resolve the first that exists;
  // when nothing exists, fall through with the first candidate so the
  // <img> reaches its broken state.
  const nativePath = pathutil.fromTreePath(imagePath);
  const candidates = pathutil.isAbsolute(nativePath)
    ? [nativePath]
    : basePaths.map((base) => pathutil.join(base, nativePath));

  const promise = (async (): Promise<ResolvedImage> => {
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const results = await platformAdapter.fs.exists(candidates);
      const hit = candidates.find(
        (candidate) =>
          results.find((r) => r.path === candidate)?.exists ?? false,
      );
      if (hit) chosen = hit;
    }
    const url = await platformAdapter.fs.resolveAssetUrl(chosen, basePaths[0]);
    return { url, absolutePath: chosen };
  })()
    .then((value) => {
      const entry = cache.get(cacheKey);
      if (entry) {
        entry.status = "fulfilled";
        entry.value = value;
      }
      return value;
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

function readEntry(entry: CacheEntry): ResolvedImage {
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
 * Resolve an image src against one or more base directories, with Suspense
 * support: throws its promise while loading (cached indefinitely to prevent
 * infinite re-renders) and the resolution error on failure.
 *
 * @param imagePath - The image file path or URL
 * @param basePaths - Candidate base directories, probed in order
 * @returns The resolved URL and the on-disk path it came from
 * @throws Promise while loading (for Suspense to catch)
 */
export function useResolvedImage(
  imagePath: string,
  basePaths: string[],
): ResolvedImage {
  const entry = useMemo(
    () => loadImage(imagePath, basePaths),
    // Joined key: callers pass fresh array literals each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imagePath, basePaths.join("|")],
  );
  return readEntry(entry);
}

/**
 * Single-base convenience over useResolvedImage returning just the URL.
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
 */
export function useImageUrl(imagePath: string, basePath: string): string {
  const entry = useMemo(
    () => loadImage(imagePath, [basePath]),
    [imagePath, basePath],
  );
  return readEntry(entry).url;
}

/**
 * Preload an image URL into the cache.
 * Call this before rendering to avoid Suspense.
 */
export function preloadImageUrl(imagePath: string, basePath: string): void {
  loadImage(imagePath, [basePath]);
}
