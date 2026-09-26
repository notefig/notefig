import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import type { BrandName } from "./brand-marks";
import { Brand } from "./marketing-mocks";
import {
  detectPlatform,
  LATEST_RELEASE_API,
  resolveDownloadTarget,
  type DownloadPlatform,
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

function initialPlatform(): DownloadPlatform {
  return typeof navigator === "undefined"
    ? "unknown"
    : detectPlatform(navigator as NavigatorHints);
}

function useDownloadTarget(): DownloadTarget & { platform: DownloadPlatform } {
  const [platform, setPlatform] = useState<DownloadPlatform>(initialPlatform);
  const [target, setTarget] = useState<DownloadTarget>(() =>
    resolveDownloadTarget(initialPlatform(), null),
  );

  useEffect(() => {
    const platform = detectPlatform(navigator as NavigatorHints);
    setPlatform(platform);
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

  return { ...target, platform };
}

const PLATFORM_MARK: Partial<Record<DownloadPlatform, BrandName>> = {
  mac: "Apple",
  windows: "Windows",
  linux: "Linux",
};

/** The visitor's OS mark (a generic download arrow when unknown). */
function PlatformIcon({ platform }: { platform: DownloadPlatform }) {
  const mark = PLATFORM_MARK[platform];
  return mark ? (
    <Brand name={mark} size={15} />
  ) : (
    <Download size={15} strokeWidth={2.25} aria-hidden="true" />
  );
}

export function DownloadAppLink({
  className,
  label: labelOverride,
}: {
  className?: string;
  /** Replaces the platform label ("Download for macOS") where space is tight. */
  label?: string;
}) {
  const { href, label, isAsset, platform } = useDownloadTarget();
  return (
    <a
      href={href}
      className={className}
      {...(isAsset ? { download: true } : { rel: "noopener" })}
    >
      <PlatformIcon platform={platform} />
      {labelOverride ?? label}
    </a>
  );
}
