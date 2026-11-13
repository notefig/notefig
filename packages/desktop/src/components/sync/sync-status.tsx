/**
 * Sync in the status bar, for the focused workspace: a cell with its
 * state, and a popover with everything sync asks or offers — turning it
 * on (or saying no on this device), the credential it pushes with, the
 * question it stops on, turning it off. Sync belongs to the workspace, so
 * it lives here rather than in the app's settings.
 *
 * Every state lays the popover out the same way, after the prompt widget's
 * card: a header row (the state's icon and name over the remote and
 * branch); a body saying what the state means or what went wrong, ending
 * in the way on (one chip, primary when sync waits on it); and a ruled
 * footer with the credential and, while on, the ways out. Every control
 * is the same chip.
 *
 * One snapshot drives it (`useSyncState`), and the credential is one
 * query each change replaces in place, so switching never flashes.
 */
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { Input } from "@notefig/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@notefig/ui/popover";
import { cn } from "@notefig/ui/utils";
import { useCore, useWorkspaceModule } from "@notefig/core/react";
import { isSshRemote } from "@notefig/git";
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

function statusOf(state: SyncState): string {
  return state.setup === "on" ? (state.fault ?? state.activity) : state.setup;
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
          data-sync-status={statusOf(state)}
          className={cn("flex items-center gap-1.5 hover:text-foreground", state.setup === "off" && "opacity-60")}
        >
          <Icon className={cn("h-3.5 w-3.5", look.tone, look.spin && "animate-spin")} />
          <span>{t(look.label)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0 text-xs">
        <SyncPanel sync={sync} state={state} />
      </PopoverContent>
    </Popover>
  );
}

/** One action at a time, with its error; `busy` names the one running. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (name: string, work: () => unknown) => {
    setBusy(name);
    setError(null);
    try {
      await work();
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

type Runner = ReturnType<typeof useAction>;

const actionTones = {
  primary: "border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
  default: "border-border text-foreground/80 hover:bg-accent hover:text-foreground",
  danger: "border-destructive/40 text-destructive hover:bg-destructive/10",
};

/** The popover's one kind of control: a chip, as the prompt widget's
 *  choices are. One primary chip, at most, for the way on. */
function Action({
  tone = "default",
  busy = false,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof actionTones; busy?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-50",
        actionTones[tone],
        className,
      )}
      {...props}
    >
      {busy && <Loader2 className="size-3 animate-spin" />}
      {children}
    </button>
  );
}

/** A band of the card, ruled off from the one above. */
function Section({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("border-t border-border/60 px-2.5 py-1.5", className)}>{children}</div>;
}

export function SyncPanel({ sync, state }: { sync: WorkspaceSync; state: SyncState }) {
  const { t } = useTranslation();
  const action = useAction();
  const look = lookOf(state);
  const Icon = look.icon;
  const { remote } = state;
  const usable = state.setup !== "unavailable" && remote !== null;
  return (
    <div data-sync-panel={statusOf(state)}>
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Icon className={cn("size-3.5 shrink-0", look.tone ?? "text-muted-foreground", look.spin && "animate-spin")} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{t(look.label)}</div>
          {(remote || state.setup !== "unavailable") && (
            <div className="truncate text-[0.6875rem] text-muted-foreground">
              {remote ? (
                `${remote.url.replace(/^https:\/\//, "").replace(/\.git$/, "")} · ${remote.branch}`
              ) : (
                <Loader2 className="my-0.5 size-3 animate-spin" />
              )}
            </div>
          )}
        </div>
      </div>
      <SyncBody state={state} error={action.error}>
        {usable &&
          (state.setup === "on" ? (
            <WayOnAction sync={sync} state={state} action={action} />
          ) : (
            <SetupActions sync={sync} state={state} action={action} />
          ))}
      </SyncBody>
      {usable && (
        <Section className="space-y-1.5">
          <Credential sync={sync} state={state} />
          {state.setup === "on" && <LeaveActions sync={sync} action={action} />}
        </Section>
      )}
    </div>
  );
}

/** What the state means, or why sync stopped; what an action hit; and the
 *  row of actions, in that order. */
function SyncBody({ state, error, children }: { state: SyncState; error: string | null; children: ReactNode }) {
  const { t } = useTranslation();
  const text = bodyText(state, t);
  if (!text && !error && !children) return null;
  const problem = state.setup === "on" && (state.fault === "diverged" || state.fault === "auth-error");
  return (
    <div className="space-y-1.5 px-2.5 pb-2">
      {text && <p className={problem ? "text-destructive" : "text-foreground/80"}>{text}</p>}
      {error && <p className="text-destructive">{error}</p>}
      {children && (
        <div data-sync-actions="" className="flex flex-wrap items-center gap-1.5">
          {children}
        </div>
      )}
    </div>
  );
}

function bodyText(state: SyncState, t: TFunction): string | null {
  switch (state.setup) {
    case "unavailable":
      return state.reason;
    case "off":
      return t("syncOffDescription");
    case "ask":
      return t("syncAskDescription");
    case "declined":
      return t("syncDeclinedDescription");
  }
  if (state.fault === "paused" && state.summary) {
    const { localFiles, remoteFiles, people, since } = state.summary;
    return t("syncPausedSummary", {
      local: localFiles.length,
      remote: remoteFiles.length,
      when: since ? new Date(since).toLocaleString() : t("syncNever"),
      people: people.join(", ") || t("syncSomeone"),
    });
  }
  return state.fault ? state.detail : null;
}

/** Not syncing here yet: turn it on, or (asked) not now. */
function SetupActions({ sync, state, action }: { sync: WorkspaceSync; state: SyncState; action: Runner }) {
  const { t } = useTranslation();
  return (
    <>
      <Action
        tone="primary"
        busy={action.busy === "turnOn"}
        disabled={action.busy !== null}
        onClick={() => void action.run("turnOn", () => sync.turnOn())}
      >
        {t(state.setup === "ask" ? "syncTurnOnHere" : "syncTurnOn")}
      </Action>
      {state.setup === "ask" && (
        <Action disabled={action.busy !== null} onClick={() => void action.run("decline", () => sync.decline())}>
          {t("syncNotNow")}
        </Action>
      )}
    </>
  );
}

/** The way on from where sync is. A stop waits on the user, and `syncNow`
 *  does nothing until `resume`, so each stop's way on resumes. */
function wayOn(sync: WorkspaceSync, state: SyncState): { label: string; stop: boolean; run: () => unknown } {
  switch (state.fault) {
    case "diverged":
      return { label: "syncKeepMine", stop: true, run: () => sync.resume() };
    case "auth-error":
      return { label: "syncRetry", stop: true, run: () => sync.resume() };
    case "paused":
      return { label: "syncNow", stop: true, run: () => sync.resume() };
    default:
      return { label: "syncNow", stop: false, run: () => sync.syncNow() };
  }
}

/** While on, the way on: sync now, or what carries on from a stop (the
 *  primary chip then, since nothing runs until it's pressed). */
function WayOnAction({ sync, state, action }: { sync: WorkspaceSync; state: SyncState; action: Runner }) {
  const { t } = useTranslation();
  const on = wayOn(sync, state);
  return (
    <Action
      tone={on.stop ? "primary" : "default"}
      busy={action.busy === "on"}
      disabled={action.busy !== null}
      onClick={() => void action.run("on", on.run)}
    >
      {t(on.label)}
    </Action>
  );
}

/** While on, the ways out: stopping here, and turning off for everyone
 *  (on a second, confirming click). */
function LeaveActions({ sync, action }: { sync: WorkspaceSync; action: Runner }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const disabled = action.busy !== null;
  return (
    <div data-sync-leave="" className="flex flex-wrap items-center gap-1.5">
      <Action busy={action.busy === "decline"} disabled={disabled} onClick={() => void action.run("decline", () => sync.decline())}>
        {t("syncStopHere")}
      </Action>
      <Action
        tone={confirming ? "danger" : "default"}
        busy={action.busy === "turnOff"}
        disabled={disabled}
        onClick={() =>
          confirming ? void action.run("turnOff", () => sync.turnOffForEveryone()) : setConfirming(true)
        }
      >
        {t(confirming ? "syncTurnOffConfirm" : "syncTurnOff")}
      </Action>
    </div>
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

/** The credential sync pushes with, and switching it. SSH remotes sign in
 *  with the user's ssh-agent, so there's nothing to switch. */
function Credential({ sync, state }: { sync: WorkspaceSync; state: SyncState }) {
  const { t } = useTranslation();
  if (isSshRemote(state.remote!.url)) return <CredentialLine>{t("syncCredential-ssh")}</CredentialLine>;
  return <TokenCredential sync={sync} state={state} />;
}

function CredentialLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <KeyRound className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-[0.6875rem] text-muted-foreground">{children}</span>
      {action}
    </div>
  );
}

function TokenCredential({ sync, state }: { sync: WorkspaceSync; state: SyncState }) {
  const { t } = useTranslation();
  const { platform } = useCore();
  const queryClient = useQueryClient();
  const url = state.remote!.url;
  // The repository whose git config applies when finding the credential.
  const repo = sync.workspacePath;
  const queryKey = ["sync-credential", repo, url];
  const credential = useQuery({
    queryKey,
    queryFn: () => platform.credentials.status(url, repo),
    staleTime: Infinity,
  });
  const [pasting, setPasting] = useState(false);
  const action = useAction();

  /** Replace the status in place, and carry on if sync stopped for it. */
  const change = (name: string, work: () => Promise<CredentialStatus | null>) =>
    action.run(name, async () => {
      queryClient.setQueryData(queryKey, await work());
      setPasting(false);
      if (state.fault === "auth-error") sync.resume();
    });

  if (credential.isPending) return <CredentialLine>{t("syncLookingForCredentials")}</CredentialLine>;
  const status = credential.data ?? null;
  const switchSource = () =>
    status?.source === "stored"
      ? void change("switch", () => platform.credentials.delete(url, repo))
      : setPasting(!pasting);
  return (
    <>
      <CredentialLine
        action={
          status && (
            <Action className="shrink-0" busy={action.busy === "switch"} disabled={action.busy !== null} onClick={switchSource}>
              {t(status.source === "stored" ? "syncUseGitCredentials" : "syncUseToken")}
            </Action>
          )
        }
      >
        {status ? t(`syncCredential-${status.source}`, { username: status.username }) : t("syncNoCredentials")}
      </CredentialLine>
      {(pasting || !status) && (
        <TokenForm
          url={url}
          busy={action.busy === "save"}
          onSave={(token) => change("save", () => platform.credentials.set(url, repo, token))}
        />
      )}
      {action.error && <p className="text-destructive">{action.error}</p>}
    </>
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
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(token).then(() => setToken(""));
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          className="h-6 px-2 text-xs"
          placeholder={t("syncTokenPlaceholder")}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Action type="submit" tone="primary" className="shrink-0" busy={busy} disabled={!token.trim() || busy}>
          {t("syncSaveToken")}
        </Action>
      </form>
      {help && (
        <div className="flex">
          <Action onClick={() => void platform.ui.openExternal(help)}>{t("syncCreateToken")}</Action>
        </div>
      )}
    </>
  );
}
