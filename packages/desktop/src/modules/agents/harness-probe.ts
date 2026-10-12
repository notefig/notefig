/**
 * The platform half of a harness's catalog probe: each adapter's
 * `discoverCatalog` is handed a login shell for the harness's own command
 * and a throwaway session (`probeHarnessSession`, beside AgentTask in
 * agent-service) in a directory that is no workspace.
 */
import type { HarnessDefinition } from "@notefig/shared/agent";
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import type {
  CatalogProbeIo,
  HarnessAdapter,
} from "@/modules/harness-adapters";
import { probeHarnessSession } from "./agent-service";
import type { CatalogProbe } from "./harness-catalog";
import { shellQuote } from "./harness-discovery";

type ProbeProc = Pick<
  IPlatformAdapter["proc"],
  "runShellCommand" | "createAgentTransport"
>;

/** The harness's own command with these args, its env set, as one line
 *  for the login shell. */
function harnessCommandLine(harness: HarnessDefinition, args: string[]): string {
  const env = Object.entries(harness.env ?? {})
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${shellQuote(value)}`);
  return [...env, shellQuote(harness.command), ...args.map(shellQuote)].join(" ");
}

/**
 * A directory that is no workspace for a probe session to open in: a
 * private one of the app's own (`mktemp -d`, mode 0700) under the system
 * temp dir, made once per app session — never a fixed path another user
 * could have put there first. Resolved by the login shell, the same one
 * install checks use; null where there is none (Windows, a browser), and
 * then no session probe runs.
 */
async function neutralDirectory(proc: ProbeProc): Promise<string | null> {
  const script =
    'd="$(mktemp -d "${TMPDIR:-/tmp}/notefig-harness-probe.XXXXXX")" && cd "$d" && printf \'__DIR__%s__END__\' "$(pwd -P)"';
  try {
    const { stdout } = await proc.runShellCommand(script);
    const match = /__DIR__(.+?)__END__/.exec(stdout);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** The catalog's probe on this platform. */
export function createCatalogProbe({
  proc,
  adapterFor,
}: {
  proc: ProbeProc;
  adapterFor: (harness: HarnessDefinition) => HarnessAdapter;
}): CatalogProbe {
  let cwd: Promise<string | null> | null = null;
  const io = (harness: HarnessDefinition, adapter: HarnessAdapter): CatalogProbeIo => ({
    async runHarness(args) {
      try {
        return await proc.runShellCommand(harnessCommandLine(harness, args));
      } catch {
        return null;
      }
    },
    async probeSession() {
      // Not cached on failure: the next probe tries again.
      cwd ??= neutralDirectory(proc).then((dir) => {
        if (!dir) cwd = null;
        return dir;
      });
      const dir = await cwd;
      if (!dir) return null;
      return probeHarnessSession({
        harness,
        adapter,
        createTransport: (spec) => proc.createAgentTransport(spec),
        cwd: dir,
      });
    },
  });
  return {
    has: (harness) => adapterFor(harness).discoverCatalog !== undefined,
    async run(harness) {
      const adapter = adapterFor(harness);
      return (await adapter.discoverCatalog?.(io(harness, adapter))) ?? null;
    },
  };
}
