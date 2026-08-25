import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  downloadLabel,
  pickAssetUrl,
  RELEASES_URL,
  resolveDownloadTarget,
  type ReleaseAsset,
} from "../links";

const assets: ReleaseAsset[] = [
  {
    name: "Notefig_0.0.113_aarch64.dmg",
    browser_download_url:
      "https://github.com/notefig/notefig/releases/download/desktop-v0.0.113/Notefig_0.0.113_aarch64.dmg",
  },
  {
    name: "Notefig_0.0.113_x64.dmg",
    browser_download_url:
      "https://github.com/notefig/notefig/releases/download/desktop-v0.0.113/Notefig_0.0.113_x64.dmg",
  },
  {
    name: "latest.json",
    browser_download_url:
      "https://github.com/notefig/notefig/releases/download/desktop-v0.0.113/latest.json",
  },
];

const windowsAssets: ReleaseAsset[] = [
  ...assets,
  {
    name: "Notefig_0.0.120_x64-setup.exe",
    browser_download_url:
      "https://github.com/notefig/notefig/releases/download/desktop-v0.0.120/Notefig_0.0.120_x64-setup.exe",
  },
];

describe("detectPlatform", () => {
  it("reads userAgentData.platform first", () => {
    expect(detectPlatform({ userAgentData: { platform: "Windows" } })).toBe(
      "windows",
    );
    expect(detectPlatform({ userAgentData: { platform: "macOS" } })).toBe("mac");
    expect(detectPlatform({ userAgentData: { platform: "Linux" } })).toBe(
      "linux",
    );
  });

  it("falls back to navigator.platform and the UA string", () => {
    expect(detectPlatform({ platform: "Win32" })).toBe("windows");
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)" })).toBe(
      "mac",
    );
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("linux");
    expect(detectPlatform({})).toBe("unknown");
  });
});

describe("pickAssetUrl", () => {
  it("prefers the Apple Silicon dmg on macOS", () => {
    expect(pickAssetUrl(assets, "mac")).toBe(
      "https://github.com/notefig/notefig/releases/download/desktop-v0.0.113/Notefig_0.0.113_aarch64.dmg",
    );
  });

  it("picks a Windows installer when one exists", () => {
    expect(pickAssetUrl(windowsAssets, "windows")?.endsWith("-setup.exe")).toBe(
      true,
    );
    expect(pickAssetUrl(assets, "windows")).toBeNull();
  });

  it("returns null for linux and unknown when those distros are not published", () => {
    expect(pickAssetUrl(assets, "linux")).toBeNull();
    expect(pickAssetUrl(assets, "unknown")).toBeNull();
  });
});

describe("resolveDownloadTarget", () => {
  it("keeps the releases page until assets are known", () => {
    expect(resolveDownloadTarget("mac", null)).toEqual({
      href: RELEASES_URL,
      label: "Download for macOS",
      isAsset: false,
    });
  });

  it("upgrades to the matching asset from the latest release", () => {
    const target = resolveDownloadTarget("mac", assets);
    expect(target.isAsset).toBe(true);
    expect(target.href).toContain("aarch64.dmg");
    expect(target.label).toBe(downloadLabel("mac"));
  });

  it("falls back to the releases page when the distro is missing", () => {
    expect(resolveDownloadTarget("windows", assets)).toEqual({
      href: RELEASES_URL,
      label: "Download for Windows",
      isAsset: false,
    });
  });
});
