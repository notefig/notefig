// Put the dictation model in the bundle: `public/dictation/`, which Vite
// copies into `dist/` for both the Tauri app and the web build. The model is
// NVIDIA's Parakeet TDT-CTC 110M (CC-BY-4.0) in sherpa-onnx's int8 ONNX
// export, run in the browser by modules/dictation/engine.
//
//   node scripts/fetch-dictation-model.mjs [--force]
//
// The pinned archive is downloaded once into a cache, its files are checked
// against the pinned sha256s, and the model is written as chunks of at most
// 24 MiB: Cloudflare Pages refuses any single file over 25 MiB. A
// `manifest.json` lists every chunk with its size and sha256, which the
// loader checks before handing the bytes to onnxruntime. Re-runs are cheap:
// the output carries a stamp of the pin and is skipped when it matches.
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const outDir = join(desktopDir, "public", "dictation");
const cacheDir = join(desktopDir, "node_modules", ".cache", "dictation-model");

export const DICTATION_MODEL_PIN = {
  version: "parakeet-tdt-ctc-110m-en-int8-1",
  archive:
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet_tdt_ctc_110m-en-36000-int8.tar.bz2",
  files: {
    "model.int8.onnx": "9177a9146cf32ee0cc8152276ef95116f312018d316be37ccf57f7efea81fc1a",
    "tokens.txt": "450e56bd2f036fe5b6aa821865838cc5aa9d8b0106134ce9a9ba0664abe6cd10",
  },
};

const CHUNK_BYTES = 24 * 1024 * 1024;

const LICENSE = `Parakeet TDT-CTC 110M (English)
Copyright NVIDIA Corporation. Licensed under the Creative Commons
Attribution 4.0 International License (CC-BY-4.0):
https://creativecommons.org/licenses/by/4.0/
Source model: https://huggingface.co/nvidia/parakeet-tdt_ctc-110m
ONNX export (int8): https://github.com/k2-fsa/sherpa-onnx
Changes: quantized to int8 by sherpa-onnx; split into chunks for hosting.
`;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const cachedFileOk = ([name, hash]) =>
  existsSync(join(cacheDir, name)) && sha256(readFileSync(join(cacheDir, name))) === hash;

async function download(url, to) {
  console.log(`[dictation] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
}

/** Extracts the archive whole (pattern and strip flags differ between bsdtar
 *  and GNU tar), then keeps only the files we ship: it also has test wavs. */
function extractPinned(archivePath) {
  const extractDir = join(cacheDir, "extract");
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir);
  const tar = spawnSync("tar", ["-xjf", archivePath, "-C", extractDir], { stdio: "inherit" });
  rmSync(archivePath);
  if (tar.status !== 0) throw new Error("extracting the dictation model failed");
  const [root] = readdirSync(extractDir);
  for (const name of Object.keys(DICTATION_MODEL_PIN.files)) {
    renameSync(join(extractDir, root, name), join(cacheDir, name));
  }
  rmSync(extractDir, { recursive: true });
}

/** The pinned files, from the cache or a fresh download of the archive. */
async function pinnedFiles() {
  const pinned = Object.entries(DICTATION_MODEL_PIN.files);
  if (pinned.every(cachedFileOk)) return;
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, "model.tar.bz2");
  await download(DICTATION_MODEL_PIN.archive, archivePath);
  extractPinned(archivePath);
  const bad = pinned.find((entry) => !cachedFileOk(entry));
  if (bad) {
    rmSync(join(cacheDir, bad[0]), { force: true });
    throw new Error(`checksum mismatch for ${bad[0]}: not the pinned ${bad[1]}`);
  }
}

export async function fetchDictationModel({ force = false } = {}) {
  // The stamp sits in the cache, not next to the output, so it isn't shipped.
  const stampFile = join(cacheDir, "output.stamp");
  const stamp = sha256(JSON.stringify(DICTATION_MODEL_PIN) + CHUNK_BYTES);
  const upToDate =
    existsSync(join(outDir, "manifest.json")) &&
    existsSync(stampFile) &&
    readFileSync(stampFile, "utf8") === stamp;
  if (!force && upToDate) return;

  await pinnedFiles();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const model = readFileSync(join(cacheDir, "model.int8.onnx"));
  const chunks = [];
  for (let offset = 0, i = 0; offset < model.length; offset += CHUNK_BYTES, i++) {
    const bytes = model.subarray(offset, offset + CHUNK_BYTES);
    const file = `model.${String(i).padStart(3, "0")}.bin`;
    writeFileSync(join(outDir, file), bytes);
    chunks.push({ file, size: bytes.length, sha256: sha256(bytes) });
  }
  const tokens = readFileSync(join(cacheDir, "tokens.txt"), "utf8");
  writeFileSync(join(outDir, "tokens.txt"), tokens);
  writeFileSync(join(outDir, "LICENSE"), LICENSE);
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        version: DICTATION_MODEL_PIN.version,
        size: model.length,
        chunks,
        tokens: { file: "tokens.txt", sha256: sha256(tokens) },
      },
      null,
      2,
    ),
  );
  writeFileSync(stampFile, stamp);
  console.log(`[dictation] wrote ${chunks.length} chunks to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await fetchDictationModel({ force: process.argv.includes("--force") });
}
