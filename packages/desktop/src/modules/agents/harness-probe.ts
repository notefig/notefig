/**
 * The harness probe: what each harness offers — its settings (the model
 * among them) and its commands and skills — found without a session the
 * user started, so a picker can show them before one exists. Each
 * harness's adapter knows how (`discoverCatalog`): a command
 * (`opencode models`) through the login shell, or a throwaway session
 * (`probeHarnessSession`, beside AgentTask) in a private directory that is
 * no workspace. What it finds lands on the harness's row through
 * `core.harnesses`, as a session's report does; when it last looked, and at
 * what, is this module's own (KV).
 *
 * It watches the harness rows: a harness switched on, found by the install
 * check, and with a way to be probed is probed when it was never probed,
 * was edited since, or was probed over a day ago — at launch, after an
 * edit or a rescan, and on a check every few hours. Probes run one at a
 * time, since each may spawn a harness.
 */
import { defineModule } from "@notefig/core";
import type { HarnessDefinition } from "@notefig/shared/agent";
import { platformModule } from "@/core/services";
import { isWeb } from "@/utils/platform";
import { kvModule, type KvApi } from "@/modules/kv";
import type { IPlatformAdapter } from "@/adapters/platform-adapter.interface";
import {
  harnessAdaptersModule,
  type CatalogProbeIo,
  type HarnessAdapter,
  type HarnessAdaptersApi,
} from "@/modules/harness-adapters";
import { probeHarnessSession } from "./agent-service";
import { shellQuote } from "./harness-discovery";
import { harnessesModule, type HarnessesApi } from "./harnesses";
import { MOCK_AGENT_MODE } from "./mock-mode";

/** How long a probe's findings stand: what a harness offers changes with
 *  its updates. A session keeps its settings current meanwhile. */
const REFRESH_MS = 24 * 60 * 60 * 1000;
/** How often every harness is asked whether its findings are stale. */
const CHECK_MS = 6 * 60 * 60 * 1000;
/** After a probe finds nothing, how long before that definition is tried
 *  again. */
const FAILED_BACKOFF_MS = 10 * 60 * 1000;
const KV_NAMESPACE = "harness-probe";

type ProbeProc = Pick<IPlatformAdapter["proc"], "runShellCommand" | "createAgentTransport">;

/** What a probe was of: what the harness is spawned with. An edit to any
 *  of it may change what it offers. */
const probedAs = ({ command, args, env }: HarnessDefinition) =>
  JSON.stringify([command, args ?? [], env ?? {}]);

/** The last probe that found something: of what, and when. */
interface Probed {
  as: string;
  at: number;
}

export function createHarnessProbe({
  harnesses,
  adapterFor,
  proc,
  kv,
  now = Date.now,
}: {
  harnesses: Pick<HarnessesApi, "ready" | "collection" | "configured" | "harness">;
  adapterFor: HarnessAdaptersApi["adapterFor"];
  proc: ProbeProc;
  kv: Pick<KvApi, "read" | "write">;
  now?: () => number;
}) {
  const io = sessionAndShell(proc);
  const failed = new Map<string, Probed>();
  const pending = new Set<string>();
  let draining: Promise<void> | null = null;

  /** Its definition, if it is switched on, was found, and can be probed. */
  const probeable = (harnessId: string) => {
    const definition = harnesses.configured().find((entry) => entry.id === harnessId);
    if (!definition || !adapterFor(definition).discoverCatalog) return undefined;
    const found = harnesses.collection.get(harnessId)?.install?.found;
    return found ? definition : undefined;
  };

  const stale = async (harnessId: string, as: string) => {
    const failure = failed.get(harnessId);
    if (failure?.as === as && now() - failure.at < FAILED_BACKOFF_MS) return false;
    const last = await kv.read<Probed>(KV_NAMESPACE, harnessId);
    return last?.as !== as || now() - last.at >= REFRESH_MS;
  };

  const probe = async (harnessId: string) => {
    const definition = probeable(harnessId);
    if (!definition) return;
    const as = probedAs(definition);
    if (!(await stale(harnessId, as))) return;
    const adapter = adapterFor(definition);
    const found = await adapter.discoverCatalog!(io(definition, adapter)).catch(() => null);
    if (!found?.configOptions?.length && !found?.commands?.length) {
      failed.set(harnessId, { as, at: now() });
      return;
    }
    failed.delete(harnessId);
    // Edited or switched off while it ran: it found the old one's. The
    // edit has asked for another look already.
    const current = probeable(harnessId);
    if (!current || probedAs(current) !== as) return;
    await kv.write<Probed>(KV_NAMESPACE, harnessId, { as, at: now() });
    await harnesses.harness(harnessId).recordOffer(found);
  };

  /** Look at each harness asked about, one at a time; one asked about
   *  again while it is looked at is looked at again after. */
  const check = (harnessIds: Iterable<string>): Promise<void> => {
    for (const harnessId of harnessIds) pending.add(harnessId);
    draining ??= (async () => {
      for (const harnessId of pending) {
        pending.delete(harnessId);
        await probe(harnessId).catch((error) =>
          console.warn(`Probing ${harnessId} for what it offers failed:`, error),
        );
      }
      draining = null;
    })();
    return draining;
  };

  const checkAll = () => check(harnesses.configured().map((entry) => entry.id));

  return {
    /** Look at the given harnesses (each is skipped unless stale). */
    check,
    /** Boot: look at every harness now, then whenever its row changes (an
     *  edit, an install check) and every `CHECK_MS`. Returns the stop. */
    start(): () => void {
      let stopped = false;
      let unsubscribe = () => {};
      void harnesses.ready().then(() => {
        if (stopped) return;
        const subscription = harnesses.collection.subscribeChanges((changes) =>
          void check(changes.map((change) => String(change.key))),
        );
        unsubscribe = () => subscription.unsubscribe();
        void checkAll();
      });
      const timer = setInterval(() => void checkAll(), CHECK_MS);
      return () => {
        stopped = true;
        unsubscribe();
        clearInterval(timer);
      };
    },
  };
}

/** The harness's own command with these args, its env set, as one line
 *  for the login shell. */
function harnessCommandLine(harness: HarnessDefinition, args: string[]): string {
  const env = Object.entries(harness.env ?? {})
    .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .map(([name, value]) => `${name}=${shellQuote(value)}`);
  return [...env, shellQuote(harness.command), ...args.map(shellQuote)].join(" ");
}

/**
 * What an adapter's `discoverCatalog` is handed on this platform: the login
 * shell for its own command, and a throwaway session in a private
 * directory (`mktemp -d`, mode 0700, made once per app session — never a
 * fixed path another user could have put there first). No login shell
 * (Windows) means no directory, and no session probe.
 */
function sessionAndShell(proc: ProbeProc) {
  let cwd: Promise<string | null> | null = null;
  const directory = async () => {
    const script =
      'd="$(mktemp -d "${TMPDIR:-/tmp}/notefig-harness-probe.XXXXXX")" && cd "$d" && printf \'__DIR__%s__END__\' "$(pwd -P)"';
    const { stdout } = await proc.runShellCommand(script);
    return /__DIR__(.+?)__END__/.exec(stdout)?.[1] ?? null;
  };
  return (harness: HarnessDefinition, adapter: HarnessAdapter): CatalogProbeIo => ({
    runHarness: (args) =>
      proc.runShellCommand(harnessCommandLine(harness, args)).catch(() => null),
    async probeSession() {
      // Not kept on failure: the next probe tries again.
      cwd ??= directory().catch(() => null);
      const dir = await cwd;
      if (!dir) {
        cwd = null;
        return null;
      }
      return probeHarnessSession({
        harness,
        adapter,
        createTransport: (spec) => proc.createAgentTransport(spec),
        cwd: dir,
      });
    },
  });
}

export type HarnessProbe = ReturnType<typeof createHarnessProbe>;

declare module "@notefig/core" {
  interface CoreModules {
    harnessProbe: HarnessProbe;
  }
}

export const harnessProbeModule = defineModule({
  name: "harnessProbe",
  needs: [platformModule, kvModule, harnessesModule, harnessAdaptersModule],
  register: (ctx) =>
    createHarnessProbe({
      harnesses: ctx.use("harnesses"),
      adapterFor: ctx.use("harnessAdapters").adapterFor,
      proc: ctx.use("platform").proc,
      kv: ctx.use("kv"),
    }),
  // A browser has no harness to spawn — on the tunnel, a transport reaches
  // the paired worker, which must not be probed behind the user's back —
  // and mock mode has no real harness either.
  boot: (probe) => (isWeb() || MOCK_AGENT_MODE ? undefined : probe.start()),
});
