import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Check, ChevronDown, Download, Globe } from "lucide-react";
import type { BrandName } from "./brand-marks";
import { Brand } from "./marketing-mocks";
import {
  APP_URL,
  detectPlatform,
  LATEST_RELEASE_API,
  pickAssetUrl,
  pickMacDmg,
  RELEASES_URL,
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

/** The visitor's platform, and the latest release's assets (null until the
 *  GitHub answer arrives; links fall back to the releases page meanwhile). */
function useDownloads(): {
  platform: DownloadPlatform;
  assets: ReleaseAsset[] | null;
} {
  const [platform, setPlatform] = useState<DownloadPlatform>(initialPlatform);
  const [assets, setAssets] = useState<ReleaseAsset[] | null>(null);

  useEffect(() => {
    setPlatform(detectPlatform(navigator as NavigatorHints));
    let cancelled = false;
    void loadLatestAssets().then((loaded) => {
      if (!cancelled) setAssets(loaded ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return { platform, assets };
}

const PLATFORM_MARK: Partial<Record<DownloadPlatform, BrandName>> = {
  mac: "Apple",
  windows: "Windows",
  linux: "Linux",
};

/** The menu's published builds, named precisely. Each links to its asset,
 *  or to the releases page until (or unless) the asset is known. */
function menuBuilds(assets: ReleaseAsset[] | null) {
  const asset = (url: string | null) =>
    assets === null ? RELEASES_URL : (url ?? RELEASES_URL);
  return [
    { key: "mac-arm64", mark: "Apple" as const, name: "macOS (Apple Silicon)", href: asset(assets && pickMacDmg(assets, "arm64")), primaryFor: "mac" },
    { key: "mac-x64", mark: "Apple" as const, name: "macOS (Intel)", href: asset(assets && pickMacDmg(assets, "x64")), primaryFor: null },
    { key: "windows", mark: "Windows" as const, name: "Windows (x64)", href: asset(assets && pickAssetUrl(assets, "windows")), primaryFor: "windows" },
  ];
}

/** The visitor's OS mark (a generic download arrow when unknown). */
function PlatformIcon({ platform, size = 15 }: { platform: DownloadPlatform; size?: number }) {
  const mark = PLATFORM_MARK[platform];
  return mark ? (
    <Brand name={mark} size={size} />
  ) : (
    <Download size={size} strokeWidth={2.25} aria-hidden="true" />
  );
}

/** "Download for macOS", shortened to "Download" on phones (the mark
 *  already says which OS), so the button and its neighbour share a row. */
function PrimaryLabel({ full }: { full: string }) {
  return (
    <>
      <span className="hidden sm:inline">{full}</span>
      <span className="sm:hidden">Download</span>
    </>
  );
}

function downloadAttrs(target: DownloadTarget) {
  return target.isAsset ? { download: true } : { rel: "noopener" };
}

/** The download call to action: the build for the OS we detected. */
export function DownloadButton() {
  const { platform, assets } = useDownloads();
  const primary = resolveDownloadTarget(platform, assets);
  return (
    <a href={primary.href} className="mk-btn mk-btn-dark" {...downloadAttrs(primary)}>
      <PlatformIcon platform={platform} />
      <PrimaryLabel full={primary.label} />
    </a>
  );
}

/**
 * The header's download: a split button whose main part downloads the build
 * for the OS we detected, and whose chevron lists every build by name, what
 * is coming, and the web app.
 */
export function HeaderDownload() {
  const { platform, assets } = useDownloads();
  const primary = resolveDownloadTarget(platform, assets);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const root = useDismissableMenu(open, close);

  return (
    <div ref={root} className="relative inline-flex">
      <a
        href={primary.href}
        className="mk-btn mk-btn-dark mk-btn-sm mk-split-main"
        {...downloadAttrs(primary)}
      >
        <PlatformIcon platform={platform} size={14} />
        Download
      </a>
      <button
        type="button"
        className="mk-btn mk-btn-dark mk-btn-sm mk-split-toggle"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="All downloads"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown size={15} strokeWidth={2.25} aria-hidden="true" />
      </button>
      {open && <DownloadMenu platform={platform} assets={assets} onPick={close} />}
    </div>
  );
}

function DownloadMenu({
  platform,
  assets,
  onPick,
}: {
  platform: DownloadPlatform;
  assets: ReleaseAsset[] | null;
  onPick: () => void;
}) {
  return (
    <div role="menu" className="mk-menu right-0">
      {menuBuilds(assets).map((build) => (
        <a
          key={build.key}
          role="menuitem"
          href={build.href}
          className="mk-menu-item"
          onClick={onPick}
          {...(build.href === RELEASES_URL ? { rel: "noopener" } : { download: true })}
        >
          <Brand name={build.mark} size={14} />
          <span className="flex-1">{build.name}</span>
          {build.primaryFor === platform && (
            <Check size={14} strokeWidth={2.25} aria-label="Your system" />
          )}
        </a>
      ))}
      <div role="menuitem" aria-disabled="true" className="mk-menu-item mk-menu-item-soon">
        <Brand name="Linux" size={14} />
        <span className="flex-1">Linux</span>
        <span className="mk-soon">Coming soon</span>
      </div>
      <div className="mk-menu-divider" />
      <a
        role="menuitem"
        href={APP_URL}
        target="_blank"
        rel="noopener"
        className="mk-menu-item"
        onClick={onPick}
      >
        <Globe size={14} strokeWidth={2} aria-hidden="true" />
        <span className="flex-1">Web app</span>
        <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
      </a>
    </div>
  );
}

/** Closes an open menu on a click outside it or on Escape. */
function useDismissableMenu(open: boolean, close: () => void) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return root;
}
