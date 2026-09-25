#!/usr/bin/env node
// Build the app's sidecar executables (MET-210) as Node single-executable
// applications: `src-tauri/binaries/<name>-<target-triple>[.exe]`, the naming
// Tauri's `bundle.externalBin` requires.
//
//   node scripts/build-sidecars.mjs [--target <triple>]... [--force] [--allow-untested]
//
// No --target = Tauri's TAURI_ENV_TARGET_TRIPLE when set (so `tauri build
// --target x` via beforeBuildCommand builds the right one), else the host
// triple. A same-OS, other-arch triple (the macOS x86_64 release leg runs on
// an arm64 runner) works too: the SEA blob is architecture-neutral, so the
// script downloads the matching official Node binary for that arch (checked
// against Node's published SHASUMS256) and injects into it. Cross-OS is not
// possible. Every output is self-tested (must answer ACP `initialize`); a
// host that can't execute the output (other arch, no Rosetta) fails the
// build unless --allow-untested says that's expected.
//
// Steps per sidecar: sidecars/bundle.mjs (isolated install of the pinned
// adapter + esbuild to one CommonJS file — shared with the CLI's vendoring)
// → SEA blob → copy of the Node binary with the blob injected (postject) →
// codesign on macOS.
// Re-runs are cheap: each output carries a stamp of every input and is
// skipped when nothing changed.
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { SIDECAR_PINS, bundleSidecar, run } from "../../../sidecars/bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, "..");
const repoRoot = resolve(desktopDir, "../..");
const sidecarsDir = join(repoRoot, "sidecars");
const outDir = join(desktopDir, "src-tauri", "binaries");
const pins = SIDECAR_PINS;

// Node's documented SEA fuse sentinel (postject flips it on injection).
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** Rust target triple → the Node download / platform facts it needs. */
const TRIPLES = {
  "aarch64-apple-darwin": { os: "darwin", arch: "arm64", nodeDist: "darwin-arm64" },
  "x86_64-apple-darwin": { os: "darwin", arch: "x64", nodeDist: "darwin-x64" },
  "x86_64-pc-windows-msvc": { os: "win32", arch: "x64", nodeDist: "win-x64" },
};

function hostTriple() {
  const match = Object.entries(TRIPLES).find(
    ([, t]) => t.os === process.platform && t.arch === process.arch,
  );
  if (!match) throw new Error(`no known target triple for ${process.platform}-${process.arch}`);
  return match[0];
}

/** Boolean flags → the option they set. `--target <triple>` is the one
 *  valued flag and is handled inline. */
const FLAGS = { "--force": "force", "--allow-untested": "allowUntested" };

function parseArgs(argv) {
  const options = { targets: [], force: false, allowUntested: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = FLAGS[argv[i]];
    if (flag) options[flag] = true;
    else if (argv[i] === "--target") options.targets.push(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!options.targets.length) {
    options.targets = [process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple()];
  }
  return options;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** postject's CLI script, resolved from its package so it runs under this
 *  same Node on every OS (the `.bin` shim is a .cmd file on Windows, which
 *  Node can't execute as a script). */
function postjectCli() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("postject/package.json");
  const { bin } = JSON.parse(readFileSync(pkgPath, "utf8"));
  const entry = typeof bin === "string" ? bin : bin?.postject;
  if (!entry) throw new Error("postject package has no bin entry");
  return join(dirname(pkgPath), entry);
}

function sha256(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

/** The published sha256 of `archive` from the release's SHASUMS256.txt. */
async function publishedSha256(distUrl, archive) {
  const url = `${distUrl}/SHASUMS256.txt`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`);
  const line = (await response.text())
    .split("\n")
    .find((l) => l.trim().endsWith(`  ${archive}`));
  if (!line) throw new Error(`${archive} not listed in ${url}`);
  return line.trim().split(/\s+/)[0];
}

/** Download + extract the official Node `version` build for `t` into
 *  cacheDir; returns the extracted binary's path. */
async function downloadNode(t, version, cacheDir, expectedBinary) {
  const base = `node-v${version}-${t.nodeDist}`;
  const archive = t.os === "win32" ? `${base}.zip` : `${base}.tar.gz`;
  const distUrl = `https://nodejs.org/dist/v${version}`;
  const url = `${distUrl}/${archive}`;
  console.log(`[sidecars] downloading ${url}`);
  mkdirSync(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, archive);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archivePath));
  // This binary ships inside the app: verify it is the release Node published.
  const expected = await publishedSha256(distUrl, archive);
  const actual = sha256(readFileSync(archivePath));
  if (actual !== expected) {
    rmSync(archivePath);
    throw new Error(`checksum mismatch for ${archive}: got ${actual}, published ${expected}`);
  }
  // bsdtar (macOS, Windows) reads both formats; gzip is auto-detected.
  run("tar", ["-xf", archivePath, "-C", cacheDir]);
  rmSync(archivePath);
  if (!existsSync(expectedBinary)) {
    throw new Error(`expected ${expectedBinary} after extracting ${archive}`);
  }
  return expectedBinary;
}

/** Node binary for a triple: the running one when arch matches, otherwise the
 *  same Node version's official build for that arch (cached under .build). */
function nodeBinaryFor(triple, cacheDir) {
  const t = TRIPLES[triple];
  if (t.os !== process.platform) {
    throw new Error(`cannot build ${triple} on ${process.platform}: SEA needs the target OS`);
  }
  if (t.arch === process.arch) return process.execPath;
  const version = process.versions.node;
  const exe = t.os === "win32" ? "node.exe" : "bin/node";
  const cached = join(cacheDir, `node-v${version}-${t.nodeDist}`, exe);
  return existsSync(cached) ? cached : downloadNode(t, version, cacheDir, cached);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function makeBlob(buildDir, bundlePath) {
  const config = join(buildDir, "sea-config.json");
  const blob = join(buildDir, "sea-prep.blob");
  writeFileSync(
    config,
    JSON.stringify(
      { main: bundlePath, output: blob, disableExperimentalSEAWarning: true },
      null,
      2,
    ),
  );
  run(process.execPath, ["--experimental-sea-config", config]);
  return blob;
}

async function inject(triple, blob, outFile, cacheDir) {
  const nodeBin = await nodeBinaryFor(triple, cacheDir);
  mkdirSync(dirname(outFile), { recursive: true });
  copyFileSync(nodeBin, outFile);
  chmodSync(outFile, 0o755);
  const t = TRIPLES[triple];
  if (t.os === "darwin") run("codesign", ["--remove-signature", outFile]);
  const args = [
    postjectCli(),
    outFile,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    SEA_FUSE,
  ];
  if (t.os === "darwin") args.push("--macho-segment-name", "NODE_SEA");
  run(process.execPath, args);
  // Ad-hoc signature so the binary launches locally; tauri-action re-signs
  // the whole bundle with the Developer ID certificate for releases.
  if (t.os === "darwin") run("codesign", ["--sign", "-", outFile]);
}

/**
 * Self-test the freshly built executable: it must start and answer ACP
 * `initialize`. A SEA can link fine and still die at startup (the first
 * build did, on `import.meta.url`), and this is where that should surface —
 * not at the user's first session. A host that can't execute the output at
 * all (other arch without Rosetta: ENOEXEC/EACCES) fails the build too,
 * unless --allow-untested says that's expected — an untested sidecar must
 * be a deliberate choice, never a silent pass.
 */
function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // partial or non-JSON line
  }
}

/** The id=1 (initialize) answer in buffered stdout, once it has arrived. */
function findInitializeAnswer(stdout) {
  return stdout.split("\n").map(parseJsonLine).find((m) => m?.id === 1);
}

function describeAgent(result) {
  const info = result.agentInfo ?? {};
  return `${info.name ?? "agent"} ${info.version ?? ""}`.trim();
}

/** How long the first start may take. A translated binary (the x86_64 one
 *  on an Apple Silicon runner) is slow the first time: Rosetta translates
 *  the whole executable before it runs, well past 20s on a cold CI runner. */
function startupTimeoutMs(triple) {
  return TRIPLES[triple].arch === process.arch ? 20_000 : 180_000;
}

function selfTest(outFile, triple, allowUntested) {
  return new Promise((resolveTest, reject) => {
    // The test proves the executable starts and speaks ACP, not that Claude
    // is installed: the entry exits early when it can't find `claude`, so
    // hand it any existing file (CI runners have no Claude) — `initialize`
    // never touches it, only a session does.
    const env = {
      ...process.env,
      CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE ?? process.execPath,
    };
    const child = spawn(outFile, [], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timeoutMs = startupTimeoutMs(triple);
    const timer = setTimeout(
      () => finish(new Error(`no initialize answer in ${timeoutMs / 1000}s\n${stderr}`)),
      timeoutMs,
    );
    const finish = (error) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      error ? reject(error) : resolveTest();
    };
    child.on("error", (error) => {
      const cannotRunHere = error.code === "ENOEXEC" || error.code === "EACCES";
      if (cannotRunHere && allowUntested) {
        console.log(`[sidecars] self-test skipped (--allow-untested): ${error.message}`);
        return finish();
      }
      finish(
        cannotRunHere
          ? new Error(`cannot execute ${outFile} on this host (${error.code}); pass --allow-untested to ship it untested`)
          : error,
      );
    });
    child.on("exit", (code) => finish(new Error(`exited ${code} before answering\n${stderr}`)));
    child.stdout.on("data", () => {
      const answer = findInitializeAnswer(stdout);
      if (answer === undefined) return;
      if (answer.result?.protocolVersion !== 1) {
        return finish(new Error(`bad initialize answer: ${JSON.stringify(answer)}`));
      }
      console.log(`[sidecars] self-test ok: ${describeAgent(answer.result)} answered initialize`);
      finish();
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: 1, clientCapabilities: {} },
      }) + "\n",
    );
  });
}

function stampFor(name, pin, triple, bundlePath) {
  return sha256(
    JSON.stringify(pin),
    readFileSync(join(sidecarsDir, name, "entry.mjs")),
    readFileSync(bundlePath),
    process.versions.node,
    triple,
    SEA_FUSE,
  );
}

async function buildOne(name, pin, triple, { force, allowUntested }) {
  const buildDir = join(sidecarsDir, name, ".build");
  mkdirSync(buildDir, { recursive: true });
  const bundlePath = join(buildDir, "bundle.cjs");
  await bundleSidecar(name, bundlePath);

  const ext = TRIPLES[triple].os === "win32" ? ".exe" : "";
  const outFile = join(outDir, `${name}-${triple}${ext}`);
  const stampFile = `${outFile}.stamp`;
  const stamp = stampFor(name, pin, triple, bundlePath);
  if (!force && existsSync(outFile) && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) {
    console.log(`[sidecars] ${name} for ${triple} is up to date`);
    return;
  }
  console.log(`[sidecars] building ${name} ${pin.version} for ${triple}`);
  const blob = makeBlob(buildDir, bundlePath);
  await inject(triple, blob, outFile, join(buildDir, "node-cache"));
  await selfTest(outFile, triple, allowUntested);
  writeFileSync(stampFile, stamp);
  const size = (statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`[sidecars] wrote ${outFile} (${size} MB)`);
}

const { targets, ...options } = parseArgs(process.argv.slice(2));
for (const triple of targets) {
  if (!TRIPLES[triple]) throw new Error(`unknown target triple ${triple}`);
}
const names = Object.keys(pins);
if (!names.length) throw new Error("no sidecars found");
for (const name of names) {
  for (const triple of targets) await buildOne(name, pins[name], triple, options);
}
