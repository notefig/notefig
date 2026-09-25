#!/usr/bin/env node
// Regenerate every logo/icon asset from the two brand paths below.
//
//   node scripts/build-icons.mjs
//
// One source of truth (the pear body + leaf paths and the tile geometry)
// fans out to:
//   brand/*.svg                       – editable SVG variants (mark, tile, macOS, Tahoe layers)
//   public/icon.svg, ../marketing/site-public/icon.svg – favicon / header mark (the tile)
//   src-tauri/icons/*.png|ico|icns    – Tauri bundle icons (Windows, Linux, pre-Tahoe macOS)
//   src-tauri/icons/menu/*.png        – macOS menu-bar item + its menu's row glyphs
//   src-tauri/icons/Notefig.icon      – Icon Composer bundle: macOS 26 Liquid Glass
//                                       (compiled to Assets.car by tauri-bundler ≥ 2.11 when
//                                       the build host has Xcode 26's actool; older hosts
//                                       fall back to icon.icns)
//
// Needs `rsvg-convert` (brew install librsvg) and, for icon.icns, macOS `iconutil`.
// The Tahoe bundle can be previewed with Icon Composer's ictool:
//   "/Applications/Icon Composer.app/Contents/Executables/ictool" src-tauri/icons/Notefig.icon \
//     --export-image --output-file /tmp/preview.png --platform macOS --rendition Default \
//     --width 512 --height 512 --scale 1
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const brand = join(desktop, "brand");
const icons = join(desktop, "src-tauri", "icons");
const marketingPublic = resolve(desktop, "..", "marketing", "site-public");

// ---- brand constants -------------------------------------------------------
const BODY_FILL = "#C56A4A";
const LEAF_FILL = "#8C8F72";
const TILE_FILL = "#F7EFE7";
// Apple's app-icon corner ratio (radius / side).
const TILE_RADIUS_RATIO = 0.2237;

// Paths in their native 180×211 box (tight bounds of the supplied artwork).
const MARK_W = 180;
const MARK_H = 211;
const BODY =
  "M74.4744 211C170.78 212.516 160.043 125.834 152.974 110C140.474 81.9999 137.604 83.2574 124.474 64.4999C117.474 54.4999 118.837 45.0908 115.974 36.4999C114.974 33.5 111.325 36.8062 113.474 29.5C118.474 12.4999 128.974 15 129.974 5.99992C130.641 -0.000283718 124.522 -9.40709e-05 121.509 0H121.474C108.236 1.24212e-05 104.602 8 102.974 12C96.057 29.0001 99.2921 20.7503 96.4741 28.5C94.4741 34 92.4746 31 90.4744 33.5C86.2885 38.7316 83.0104 45.6708 69.4741 56.5C46.9744 74.5 30.6686 81.9173 10.9743 110C-16.0256 148.5 7.41261 209.944 74.4744 211Z";
const LEAF =
  "M154.422 16.7531C137.35 11.5508 117.781 26.1789 117.781 27.5895C117.781 29.0001 127.438 48.525 143.719 50.5125C160 52.5 170 46.5 180 41C173.5 36 170 21.5001 154.422 16.7531Z";

// Tile geometry: 1024 canvas, mark 64% of the tile height, centred.
const CANVAS = 1024;
const MARK_HEIGHT = 660;
const S = MARK_HEIGHT / MARK_H;
const TX = (CANVAS - MARK_W * S) / 2;
const TY = (CANVAS - MARK_HEIGHT) / 2;
const TILE_R = Math.round(CANVAS * TILE_RADIUS_RATIO); // 229

// Pre-Tahoe macOS: artwork at ~83% of the canvas, transparent margin, so the
// icon sits on the same grid as Apple's (see AGENTS.md "App Icons (macOS)").
const MACOS_CONTENT = 0.829;
const MACOS_INSET = (CANVAS * (1 - MACOS_CONTENT)) / 2;

const f = (n) => Number(n.toFixed(3));
const svg = (body, size = CANVAS) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">\n${body}\n</svg>\n`;
const markGroup = (paths) =>
  `  <g transform="translate(${f(TX)} ${f(TY)}) scale(${f(S)})">\n${paths}\n  </g>`;
const bodyPath = `    <path fill="${BODY_FILL}" d="${BODY}"/>`;
const leafPath = `    <path fill="${LEAF_FILL}" d="${LEAF}"/>`;
const tileRect = `  <rect width="${CANVAS}" height="${CANVAS}" rx="${TILE_R}" ry="${TILE_R}" fill="${TILE_FILL}"/>`;

// ---- SVG variants ----------------------------------------------------------
const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_W} ${MARK_H}" width="${MARK_W}" height="${MARK_H}">\n${leafPath}\n${bodyPath}\n</svg>\n`;
const tileSvg = svg(`${tileRect}\n${markGroup(`${leafPath}\n${bodyPath}`)}`);
const macosSvg = svg(
  `  <g transform="translate(${f(MACOS_INSET)} ${f(MACOS_INSET)}) scale(${MACOS_CONTENT})">\n${tileRect}\n${markGroup(`${leafPath}\n${bodyPath}`)}\n  </g>`,
);
// Tahoe layers: each a full 1024 canvas holding only its shape, so the
// Icon Composer bundle registers them with scale 1 / offset 0.
const layerBodySvg = svg(markGroup(bodyPath));
const layerLeafSvg = svg(markGroup(leafPath));

mkdirSync(brand, { recursive: true });
writeFileSync(join(brand, "mark.svg"), markSvg);
writeFileSync(join(brand, "tile.svg"), tileSvg);
writeFileSync(join(brand, "icon-macos.svg"), macosSvg);
writeFileSync(join(brand, "layer-body.svg"), layerBodySvg);
writeFileSync(join(brand, "layer-leaf.svg"), layerLeafSvg);

// Favicons / header mark (the .ico / apple-touch-icon fallbacks are written
// with the rasters below).
writeFileSync(join(desktop, "public", "icon.svg"), tileSvg);
writeFileSync(join(marketingPublic, "icon.svg"), tileSvg);

// ---- Icon Composer bundle (macOS 26) --------------------------------------
const srgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => (v / 255).toFixed(5);
  return `srgb:${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)},1.00000`;
};
const layer = (name) => ({
  "image-name": `${name}.svg`,
  name,
  glass: true,
  position: { scale: 1, "translation-in-points": [0, 0] },
});
const iconJson = {
  // Keep the cream tile in dark mode too (a bare `fill` gets the system
  // dark backdrop substituted in the Dark rendition).
  "fill-specializations": [
    { value: { solid: srgb(TILE_FILL) } },
    { appearance: "dark", value: { solid: srgb(TILE_FILL) } },
  ],
  groups: [
    {
      name: "Pear",
      // Bottom-most first: the leaf sits over the stem.
      layers: [layer("body"), layer("leaf")],
      specular: true,
      shadow: { kind: "neutral", opacity: 0.5 },
      "blur-material": null,
    },
  ],
  "supported-platforms": { squares: "shared", circles: ["watchOS"] },
};
const bundle = join(icons, "Notefig.icon");
rmSync(bundle, { recursive: true, force: true });
mkdirSync(join(bundle, "Assets"), { recursive: true });
writeFileSync(
  join(bundle, "icon.json"),
  JSON.stringify(iconJson, null, 2) + "\n",
);
writeFileSync(join(bundle, "Assets", "body.svg"), layerBodySvg);
writeFileSync(join(bundle, "Assets", "leaf.svg"), layerLeafSvg);

// ---- rasters ---------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), "notefig-icons-"));

// ---- menu bar (src-tauri/src/app_status.rs) --------------------------------
// The status item and its menu's row glyphs, at 2x of the 18pt height AppKit
// draws them at. The item is a template image (black on transparent, tinted
// by the system); the row glyphs are the sidebar's status marks in its
// colours, drawn once to read on both menu appearances, plus a document.
const MENU_PX = 36;
const menuDir = join(icons, "menu");
mkdirSync(menuDir, { recursive: true });
const GLYPH_GREY = "#8e8e93";
const GLYPH_SUCCESS = "#979a7e";
const GLYPH_WARNING = "#c9533a";
const rasterSvg = (svgText, w, h, out) => {
  const src = join(work, `${out.split("/").pop()}.svg`);
  writeFileSync(src, svgText);
  execFileSync("rsvg-convert", ["-w", String(w), "-h", String(h), src, "-o", out]);
};
const markBlack = `<path fill="#000" d="${BODY}"/>\n<path fill="#000" d="${LEAF}"/>`;
const menuSvg = (body, w = MENU_PX) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${MENU_PX}" width="${w}" height="${MENU_PX}">\n${body}\n</svg>\n`;
// The mark 32px tall, centred; the attention variant adds a dot beside it.
const markScale = 32 / MARK_H;
const markW = MARK_W * markScale;
const trayMark = (x) =>
  `<g transform="translate(${f(x)} 2) scale(${f(markScale)})">\n${markBlack}\n</g>`;
rasterSvg(menuSvg(trayMark((MENU_PX - markW) / 2)), MENU_PX, MENU_PX, join(menuDir, "logo.png"));
const attentionW = Math.round(markW + 18);
rasterSvg(
  menuSvg(`${trayMark(0)}\n<circle cx="${attentionW - 5}" cy="18" r="5" fill="#000"/>`, attentionW),
  attentionW,
  MENU_PX,
  join(menuDir, "logo-attention.png"),
);
const dot = (fill) => `<circle cx="18" cy="18" r="6" fill="${fill}"/>`;
const ring = (stroke) => `<circle cx="18" cy="18" r="5" fill="none" stroke="${stroke}" stroke-width="2"/>`;
// Moving: the sidebar's orb, still — a dot inside a wider ring.
const pulse = (fill) =>
  `<circle cx="18" cy="18" r="9" fill="none" stroke="${fill}" stroke-width="2" opacity="0.45"/>\n<circle cx="18" cy="18" r="4" fill="${fill}"/>`;
const document = (fill) =>
  `<path fill="none" stroke="${fill}" stroke-width="2" stroke-linejoin="round" d="M11 7h9l6 6v16H11z M20 7v6h6"/>`;
for (const [name, body] of [
  ["running", pulse(GLYPH_GREY)],
  ["settled", ring(GLYPH_GREY)],
  ["queued", ring(GLYPH_WARNING)],
  ["error", dot(GLYPH_WARNING)],
  ["attention", dot(GLYPH_SUCCESS)],
  ["document", document(GLYPH_GREY)],
]) {
  rasterSvg(menuSvg(body), MENU_PX, MENU_PX, join(menuDir, `${name}.png`));
}

const tileFile = join(brand, "tile.svg");
const macosFile = join(brand, "icon-macos.svg");
const png = (src, size, out) =>
  execFileSync("rsvg-convert", [
    "-w",
    String(size),
    "-h",
    String(size),
    src,
    "-o",
    out,
  ]);

// Windows / Linux / window icons: the full-bleed tile.
for (const [name, size] of [
  ["32x32.png", 32],
  ["64x64.png", 64],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
  ["StoreLogo.png", 50],
  ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map((s) => [
    `Square${s}x${s}Logo.png`,
    s,
  ]),
]) {
  png(tileFile, size, join(icons, name));
}

// .ico with PNG-compressed entries (Vista+ / every browser).
const ico = (sizes) => {
  const entries = sizes.map((s) => {
    const file = join(work, `ico-${s}.png`);
    png(tileFile, s, file);
    return { s, data: readFileSync(file) };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = entries.map(({ s, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s === 256 ? 0 : s, 0);
    e.writeUInt8(s === 256 ? 0 : s, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
};
writeFileSync(join(icons, "icon.ico"), ico([256, 128, 64, 48, 32, 24, 16]));

// Web favicons: the SVG is linked first; .ico and apple-touch-icon cover
// Safari (no SVG favicons) and home-screen bookmarks. The docs theme
// (Next.js) serves its favicon straight from public/.
const webFavicon = ico([48, 32, 16]);
const docsTheme = resolve(
  desktop,
  "..",
  "themes",
  "notefig-theme-next",
  "public",
);
for (const dir of [join(desktop, "public"), marketingPublic, docsTheme]) {
  writeFileSync(join(dir, "favicon.ico"), webFavicon);
  png(tileFile, 180, join(dir, "apple-touch-icon.png"));
}

// macOS (pre-Tahoe) .icns via iconutil from a temporary iconset.
png(macosFile, 1024, join(icons, "master_1024.png"));
const iconset = join(work, "icon.iconset");
mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  png(macosFile, s, join(iconset, `icon_${s}x${s}.png`));
  png(macosFile, s * 2, join(iconset, `icon_${s}x${s}@2x.png`));
}
if (process.platform === "darwin") {
  execFileSync("iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    join(icons, "icon.icns"),
  ]);
} else {
  console.warn("iconutil unavailable: icon.icns not regenerated");
}
rmSync(work, { recursive: true, force: true });
console.log(
  `icons written to ${icons}, ${brand}, public/icon.svg and marketing site-public/icon.svg`,
);
