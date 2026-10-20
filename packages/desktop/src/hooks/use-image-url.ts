import { useMemo } from "react";
import type { FileSystemSurface } from "@/adapters/platform-adapter.interface";
import { buildInternalCandidates } from "@/components/editor/tiptap-link-utils";
import { useCore } from "@notefig/core/react";

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

type ImageFs = Pick<FileSystemSurface, "exists" | "resolveAssetUrl">;

/**
 * Local image src → candidate absolute paths, in priority order. Mirrors the
 * page-link resolver: file-relative first, workspace root second, with `.`/
 * `..` collapsed and paths outside the workspace refused.
 */
export function resolveImageCandidates(
  imagePath: string,
  basePaths: string[],
): string[] {
  const fileDir = basePaths[0];
  const workspaceRoot = basePaths[basePaths.length - 1] ?? fileDir;
  return buildInternalCandidates(imagePath, {
    fileDir,
    basePath: workspaceRoot,
  });
}

function loadImage(
  fs: ImageFs,
  imagePath: string,
  basePaths: string[],
): CacheEntry {
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

  // Local paths — a relative src can be anchored at the containing file's
  // directory or at the workspace root (Obsidian accepts both), and `..`
  // segments resolve before the path reaches the platform. Reuse the link
  // resolver so images and page links agree on what a path means, and so
  // traversal outside the workspace is refused rather than handed to the OS.
  const candidates = resolveImageCandidates(imagePath, basePaths);
  const workspaceRoot = basePaths[basePaths.length - 1] ?? basePaths[0];

  if (candidates.length === 0) {
    const error = new Error(
      `image path is outside the workspace: ${imagePath}`,
    );
    const promise = Promise.reject(error);
    // readEntry throws the stored error, so nothing ever awaits this
    // promise; handle it here so a refused image isn't reported as an
    // unhandled rejection before the boundary renders its fallback.
    promise.catch(() => {});
    const entry: CacheEntry = {
      promise,
      status: "rejected",
      error,
    };
    cache.set(cacheKey, entry);
    return entry;
  }

  const promise = (async (): Promise<ResolvedImage> => {
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const results = await fs.exists(candidates);
      const hit = candidates.find(
        (candidate) =>
          results.find((r) => r.path === candidate)?.exists ?? false,
      );
      if (hit) chosen = hit;
    }
    const url = await fs.resolveAssetUrl(chosen, workspaceRoot);
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
  const { fs } = useCore().platform;
  const entry = useMemo(
    () => loadImage(fs, imagePath, basePaths),
    // Joined key: callers pass fresh array literals each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fs, imagePath, basePaths.join("|")],
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
  return useResolvedImage(imagePath, [basePath]).url;
}
