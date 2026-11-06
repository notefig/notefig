/**
 * The backend the perf suite measures against: the release `test-shim`
 * from PERF_BUILD, started by the specs rather than as a Playwright web
 * server, so a measurement can start from a fresh process as an app
 * launch does. The shim wipes its database when it starts.
 *
 * A fresh process per sample matters for opening a workspace: in one
 * long-lived shim, opening the same 20k-file workspace again (after a page
 * reload, even after closing it) stalls every backend call for 4–5 s
 * behind `start_watching_metadata`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import path from "node:path";

/**
 * Baked into the build (`VITE_TEST_BACKEND_PORT` in perf-build.sh); set
 * PERF_SHIM_PORT for both to run two checkouts' suites side by side.
 */
const PORT = Number(process.env.PERF_SHIM_PORT ?? 4599);

const binary = path.join(process.env.PERF_BUILD ?? "perf-build", "test-shim");

async function healthy(): Promise<boolean> {
  try {
    return (await fetch(`http://127.0.0.1:${PORT}/health`)).ok;
  } catch {
    return false;
  }
}

async function until(condition: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 15_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`shim: timed out ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

interface Shim {
  stop(): Promise<void>;
}

/**
 * Start a shim, run `body` against it, and stop it however `body` ends: a
 * shim left behind holds the port, and every later run would fail on it.
 */
export async function withShim<T>(body: () => Promise<T>): Promise<T> {
  const shim = await startShim();
  try {
    return await body();
  } finally {
    await shim.stop();
  }
}

async function startShim(): Promise<Shim> {
  if (await healthy())
    throw new Error(`port ${PORT} is taken: another shim would be measured`);
  const child: ChildProcess = spawn(binary, ["--port", String(PORT)], {
    stdio: "ignore",
  });
  await until(healthy, "starting");
  return {
    // Waits for the exit rather than polling: a request to a shim that is
    // going away can fail outside the caller's catch.
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
  };
}
