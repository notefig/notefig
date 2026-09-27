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
    // Apple Silicon is the default (userAgentData does not expose arch);
    // Intel Macs pick their build from the header's download menu.
    return (
      pickMacDmg(assets, "arm64") ??
      lower.find((asset) => asset.name.endsWith(".dmg"))?.url ??
      null
    );
  }

  // No Linux build is published yet.
  return null;
}

export type MacArch = "arm64" | "x64";

/** The macOS disk image for one architecture (Tauri names them aarch64 and
 *  x64), or null when the release doesn't carry it. */
export function pickMacDmg(
  assets: readonly ReleaseAsset[],
  arch: MacArch,
): string | null {
  const tag = arch === "arm64" ? "aarch64" : "x64";
  return (
    assets.find((asset) => {
      const name = asset.name.toLowerCase();
      return name.endsWith(".dmg") && name.includes(tag);
    })?.browser_download_url ?? null
  );
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
