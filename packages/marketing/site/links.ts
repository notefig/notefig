export const APP_URL = "https://app.notefig.com";
export const GITHUB_URL = "https://github.com/notefig/notefig";
export const RELEASES_URL = "https://github.com/notefig/notefig/releases";
/** Public GitHub API for the repo's latest (desktop) release assets. */
export const LATEST_RELEASE_API =
  "https://api.github.com/repos/notefig/notefig/releases/latest";

export type DownloadPlatform = "windows" | "mac" | "linux" | "unknown";

export interface NavigatorHints {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface DownloadTarget {
  href: string;
  label: string;
  isAsset: boolean;
}

export function detectPlatform(nav: NavigatorHints): DownloadPlatform {
  const platform = (
    nav.userAgentData?.platform ??
    nav.platform ??
    ""
  ).toLowerCase();
  const ua = (nav.userAgent ?? "").toLowerCase();

  if (platform.includes("win") || ua.includes("windows")) return "windows";
  if (
    platform.includes("mac") ||
    platform.includes("darwin") ||
    ua.includes("mac os")
  ) {
    return "mac";
  }
  if (platform.includes("linux") || ua.includes("linux")) return "linux";
  return "unknown";
}

export function downloadLabel(platform: DownloadPlatform): string {
  if (platform === "windows") return "Download for Windows";
  if (platform === "mac") return "Download for macOS";
  if (platform === "linux") return "Download for Linux";
  return "Download the app";
}

export function pickAssetUrl(
  assets: readonly ReleaseAsset[],
  platform: DownloadPlatform,
): string | null {
  const lower = assets.map((asset) => ({
    name: asset.name.toLowerCase(),
    url: asset.browser_download_url,
  }));

  if (platform === "windows") {
    return (
      lower.find(
        (asset) =>
          asset.name.endsWith("-setup.exe") || asset.name.endsWith(".msi"),
      )?.url ?? null
    );
  }

  if (platform === "mac") {
    // Apple Silicon is the default; Intel Macs can install via Rosetta or
    // pick x64 from the releases page. userAgentData does not expose arch.
    return (
      lower.find(
        (asset) =>
          asset.name.endsWith(".dmg") && asset.name.includes("aarch64"),
      )?.url ??
      lower.find((asset) => asset.name.endsWith(".dmg"))?.url ??
      null
    );
  }

  if (platform === "linux") {
    return (
      lower.find(
        (asset) =>
          asset.name.endsWith(".appimage") || asset.name.endsWith(".deb"),
      )?.url ?? null
    );
  }

  return null;
}

export function resolveDownloadTarget(
  platform: DownloadPlatform,
  assets: readonly ReleaseAsset[] | null,
): DownloadTarget {
  const label = downloadLabel(platform);
  const href = assets ? pickAssetUrl(assets, platform) : null;
  if (!href) return { href: RELEASES_URL, label, isAsset: false };
  return { href, label, isAsset: true };
}
