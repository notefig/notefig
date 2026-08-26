import { useEffect, useState } from "react";
import {
  detectPlatform,
  LATEST_RELEASE_API,
  resolveDownloadTarget,
  type DownloadTarget,
  type NavigatorHints,
  type ReleaseAsset,
} from "./links";

let assetsPromise: Promise<ReleaseAsset[] | null> | null = null;

function isReleaseAsset(value: unknown): value is ReleaseAsset {
  if (!value || typeof value !== "object") return false;
  const asset = value as Record<string, unknown>;
  return (
    typeof asset.name === "string" &&
    typeof asset.browser_download_url === "string"
  );
}

async function fetchLatestAssets(): Promise<ReleaseAsset[] | null> {
  try {
    const response = await fetch(LATEST_RELEASE_API, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return null;
    const assets = (body as { assets?: unknown }).assets;
    if (!Array.isArray(assets)) return null;
    return assets.filter(isReleaseAsset);
  } catch {
    return null;
  }
}

function loadLatestAssets(): Promise<ReleaseAsset[] | null> {
  assetsPromise ??= fetchLatestAssets();
  return assetsPromise;
}

function useDownloadTarget(): DownloadTarget {
  const [target, setTarget] = useState<DownloadTarget>(() =>
    resolveDownloadTarget(
      typeof navigator === "undefined"
        ? "unknown"
        : detectPlatform(navigator as NavigatorHints),
      null,
    ),
  );

  useEffect(() => {
    const platform = detectPlatform(navigator as NavigatorHints);
    setTarget(resolveDownloadTarget(platform, null));
    let cancelled = false;
    void loadLatestAssets().then((assets) => {
      if (!cancelled) {
        setTarget(resolveDownloadTarget(platform, assets ?? []));
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return target;
}

export function DownloadAppLink({ className }: { className?: string }) {
  const { href, label, isAsset } = useDownloadTarget();
  return (
    <a
      href={href}
      className={className}
      {...(isAsset ? { download: true } : { rel: "noopener" })}
    >
      {label}
    </a>
  );
}
