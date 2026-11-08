/**
 * Sync in the status bar, for the focused workspace: a cell with its
 * state, and a popover with everything sync asks or offers — turning it
 * on (or saying no on this device), the credential it pushes with, the
 * question it stops on, turning it off. Sync belongs to the workspace, so
 * it lives here rather than in the app's settings.
 *
 * One snapshot drives it (`useSyncState`), and the credential is one
 * query each change replaces in place, so switching never flashes.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CloudOff,
  GitBranch,
  KeyRound,
  Loader2,
  PauseCircle,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@notefig/ui/button";
import { Input } from "@notefig/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@notefig/ui/popover";
import { cn } from "@notefig/ui/utils";
import { useCore, useWorkspaceModule } from "@notefig/core/react";
import type { CredentialStatus } from "@/adapters/platform-adapter.interface";
import type { SyncState, WorkspaceSync } from "@/modules/sync";
import { useSyncState } from "@/modules/sync/react";

interface Look {
  icon: LucideIcon;
  label: string;
  tone?: string;
  spin?: boolean;
}

function lookOf(state: SyncState): Look {
  if (state.setup === "off" || state.setup === "unavailable") return { icon: CloudOff, label: "syncOff" };
  if (state.setup !== "on") return { icon: CloudOff, label: "syncNotSyncing", tone: "text-warning" };
  switch (state.fault) {
    case "offline":
      return { icon: CloudOff, label: "syncOffline", tone: "text-warning" };
    case "throttled":
      return { icon: CloudOff, label: "syncThrottled", tone: "text-warning" };
    case "auth-error":
      return { icon: KeyRound, label: "syncAuthError", tone: "text-destructive" };
    case "diverged":
      return { icon: AlertTriangle, label: "syncStopped", tone: "text-destructive" };
    case "paused":
      return { icon: PauseCircle, label: "syncPaused", tone: "text-warning" };
  }
  if (state.activity === "idle") return { icon: GitBranch, label: "syncSynced", tone: "text-success" };
  return { icon: Loader2, label: `sync-${state.activity}`, spin: true };
}

export function SyncStatusCell({ workspacePath }: { workspacePath: string | null }) {
  const { t } = useTranslation();
  const state = useSyncState(workspacePath);
  const sync = useWorkspaceModule(workspacePath, "sync");
  const [open, setOpen] = useState(false);
  // A project that syncs asks this device once, when it opens.
  useEffect(() => {
    if (state.setup === "ask") setOpen(true);
  }, [state.setup]);
  // A folder that isn't a repo, or the web: nothing to show.
  if (!sync || (state.setup === "unavailable" && !state.reason)) return null;
  const look = lookOf(state);
  const Icon = look.icon;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void sync.inspect();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="sync-status"
          data-sync-status={state.setup === "on" ? (state.fault ?? state.activity) : state.setup}
          className={cn("flex items-center gap-1.5 hover:text-foreground", state.setup === "off" && "opacity-60")}
        >
          <Icon className={cn("h-3.5 w-3.5", look.tone, look.spin && "animate-spin")} />
          <span>{t(look.label)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 space-y-3 p-3 text-xs">
        <SyncPanel sync={sync} state={state} />
      </PopoverContent>
    </Popover>
  );
}

/** One action at a time, with its error. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function SyncPanel({ sync, state }: { sync: WorkspaceSync; state: SyncState }) {
  const { t } = useTranslation();
  const action = useAction();
  const { remote } = state;
  if (state.setup === "unavailable") return <p className="text-muted-foreground">{state.reason}</p>;
  if (!remote) return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  const where = `${remote.url.replace(/^https:\/\//, "").replace(/\.git$/, "")} · ${remote.branch}`;

  const turnOn = (
    <Button size="sm" disabled={action.busy} onClick={() => void action.run(() => sync.turnOn())}>
      {action.busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
      {t(state.setup === "ask" ? "syncTurnOnHere" : "syncTurnOn")}
    </Button>
  );

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{t("syncTitle")}</span>
        <span className="truncate text-muted-foreground">{where}</span>
      </div>
      {state.setup === "off" && <p>{t("syncOffDescription")}</p>}
      {state.setup === "ask" && <p>{t("syncAskDescription")}</p>}
      {state.setup === "declined" && <p>{t("syncDeclinedDescription")}</p>}
      {state.setup === "on" && <SyncProblem sync={sync} state={state} />}
      <CredentialRow sync={sync} state={state} />
      {action.error && <p className="text-destructive">{action.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {state.setup !== "on" && turnOn}
        {state.setup === "ask" && (
          <Button size="sm" variant="ghost" onClick={() => void action.run(() => sync.decline())}>
            {t("syncNotNow")}
          </Button>
        )}
        {state.setup === "on" && <SyncOnActions sync={sync} />}
      </div>
    </>
  );
}

/** Why sync stopped, and the way on. */
function SyncProblem({ sync, state }: { sync: WorkspaceSync; state: SyncState }) {
  const { t } = useTranslation();
  if (state.fault === "paused" && state.summary) {
    const { localFiles, remoteFiles, people, since } = state.summary;
    return (
      <div className="space-y-2">
        <p>
          {t("syncPausedSummary", {
            local: localFiles.length,
            remote: remoteFiles.length,
            when: since ? new Date(since).toLocaleString() : t("syncNever"),
            people: people.join(", ") || t("syncSomeone"),
          })}
        </p>
        <Button size="sm" onClick={() => sync.resume()}>
          {t("syncNow")}
        </Button>
      </div>
    );
  }
  if (!state.fault) return null;
  return (
    <div className="space-y-2">
      {state.detail && <p className={cn(state.fault === "diverged" && "text-destructive")}>{state.detail}</p>}
      {state.fault === "diverged" && (
        <Button size="sm" variant="outline" onClick={() => sync.resume()}>
          {t("syncKeepMine")}
        </Button>
      )}
    </div>
  );
}

function SyncOnActions({ sync }: { sync: WorkspaceSync }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const link = "text-muted-foreground underline-offset-2 hover:text-foreground hover:underline";
  return (
    <>
      <button type="button" className={link} onClick={() => void sync.syncNow()}>
        {t("syncNow")}
      </button>
      <button type="button" className={link} onClick={() => void sync.decline()}>
        {t("syncStopHere")}
      </button>
      <button
        type="button"
        className={cn(link, confirming && "text-destructive")}
        onClick={() => (confirming ? void sync.turnOffForEveryone() : setConfirming(true))}
      >
        {t(confirming ? "syncTurnOffConfirm" : "syncTurnOff")}
      </button>
    </>
  );
}

/** Where to create a token with only what sync needs. */
function tokenHelp(url: string): string | null {
  const { host, pathname } = new URL(url);
  if (host === "github.com") {
    const owner = pathname.split("/")[1] ?? "";
    return `https://github.com/settings/personal-access-tokens/new?name=Notefig+sync&target_name=${owner}&contents=write`;
  }
  if (host.includes("gitlab")) {
    return `https://${host}/-/user_settings/personal_access_tokens?name=Notefig+sync&scopes=read_repository,write_repository`;
  }
  return null;
}

/** The credential sync pushes with, and switching it. */
function CredentialRow({ sync, state }: { sync: WorkspaceSync; state: SyncState }) {
  const { t } = useTranslation();
  const { platform } = useCore();
  const queryClient = useQueryClient();
  const url = state.remote!.url;
  const queryKey = ["sync-credential", url];
  const credential = useQuery({
    queryKey,
    queryFn: () => platform.credentials.status(url),
    staleTime: Infinity,
  });
  const [pasting, setPasting] = useState(false);
  const action = useAction();

  /** Replace the status in place, and carry on if sync stopped for it. */
  const change = (work: () => Promise<CredentialStatus | null>) =>
    action.run(async () => {
      queryClient.setQueryData(queryKey, await work());
      setPasting(false);
      if (state.fault === "auth-error") sync.resume();
    });

  if (credential.isPending) return <p className="text-muted-foreground">{t("syncLookingForCredentials")}</p>;
  const status = credential.data ?? null;
  const switchSource = () =>
    status?.source === "stored" ? void change(() => platform.credentials.delete(url)) : setPasting(!pasting);
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground">
        {status ? t(`syncCredential-${status.source}`, { username: status.username }) : t("syncNoCredentials")}{" "}
        {status && (
          <Switch onClick={switchSource}>
            {t(status.source === "stored" ? "syncUseGitCredentials" : "syncUseToken")}
          </Switch>
        )}
      </p>
      {(pasting || !status) && (
        <TokenForm url={url} busy={action.busy} onSave={(token) => change(() => platform.credentials.set(url, token))} />
      )}
      {action.error && <p className="text-destructive">{action.error}</p>}
    </div>
  );
}

function TokenForm({ url, busy, onSave }: { url: string; busy: boolean; onSave: (token: string) => Promise<void> }) {
  const { t } = useTranslation();
  const { platform } = useCore();
  const [token, setToken] = useState("");
  const help = tokenHelp(url);
  return (
    <>
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(token).then(() => setToken(""));
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          className="h-7 text-xs"
          placeholder={t("syncTokenPlaceholder")}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={!token.trim() || busy}>
          {t("syncSaveToken")}
        </Button>
      </form>
      {help && <Switch onClick={() => void platform.ui.openExternal(help)}>{t("syncCreateToken")}</Switch>}
    </>
  );
}

function Switch({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={onClick}>
      {children}
    </button>
  );
}
