/**
 * The workspace's Remote tool in the sidebar: where it syncs, how it signs
 * in, and sync itself — turning it on (or not, on this device), the
 * question it stops on, turning it off.
 *
 * Laid out like the sidebar's other tools (Sessions): a tool bar with the
 * state on the left and its actions on the right (sync now, and the ways
 *  out in a menu); the repository, branch and sign-in, stacked; then one message — what
 * the state means, or what to fix — and at most two small buttons under
 * it. Every state keeps that order, so nothing jumps between them.
 *
 * One snapshot drives it (`useSyncState`), and the credential is one query
 * each change replaces in place, so switching never flashes.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Loader2, MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@notefig/ui/button";
import { Input } from "@notefig/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@notefig/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@notefig/ui/alert-dialog";
import { cn } from "@notefig/ui/utils";
import { useCore, useWorkspaceModule } from "@notefig/core/react";
import { isSshRemote, remoteLabel } from "@notefig/git";
import { SidebarSeparator, ToolBar } from "@/components/editor/tool-bar";
import type { CredentialStatus } from "@/adapters/platform-adapter.interface";
import type { SyncState, WorkspaceSync } from "@/modules/sync";
import { useSyncState } from "@/modules/sync/react";
import { lookOf, statusOf } from "./sync-look";

/** The focused workspace's Remote tool. */
export function RemotePanel({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation();
  const state = useSyncState(workspacePath);
  const sync = useWorkspaceModule(workspacePath, "sync");
  // Read the repo's remote when the tool opens, for a project not syncing yet.
  useEffect(() => void sync?.inspect(), [sync]);
  if (!sync)
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {t("syncUnsupported")}
      </p>
    );
  return <SyncPanel sync={sync} state={state} />;
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

/** The tool's one kind of button, sized as the sidebar's (Sessions' new
 *  session): small, quiet, outlined. */
function Small({
  busy,
  children,
  ...props
}: { busy?: boolean; children: ReactNode } & Omit<
  React.ComponentProps<typeof Button>,
  "variant" | "size"
>) {
  return (
    <Button
      variant="outline"
      className="h-6 gap-1 px-2 text-xs font-normal [&_svg]:size-3"
      {...props}
    >
      {busy && <Loader2 className="animate-spin" />}
      {children}
    </Button>
  );
}

export function SyncPanel({
  sync,
  state,
}: {
  sync: WorkspaceSync;
  state: SyncState;
}) {
  const action = useAction();
  const usable = state.setup !== "unavailable" && state.remote !== null;
  return (
    <div
      data-sync-panel={statusOf(state)}
      className="flex h-full min-h-0 flex-col"
    >
      <StateBar sync={sync} state={state} action={action} />
      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-2 text-xs">
        {usable && <RemoteRows sync={sync} state={state} />}
        {usable && <SidebarSeparator className="mx-0" />}
        <Message state={state} error={action.error}>
          {usable && <Actions sync={sync} state={state} action={action} />}
        </Message>
      </div>
    </div>
  );
}

/** The state, and while on, sync now and the ways out. */
function StateBar({
  sync,
  state,
  action,
}: {
  sync: WorkspaceSync;
  state: SyncState;
  action: Runner;
}) {
  const { t } = useTranslation();
  const look = lookOf(state);
  const Icon = look.icon;
  const on = state.setup === "on";
  // A stop waits for its way on, under the message; sync now does nothing then.
  const stuck =
    state.fault === "auth-error" ||
    state.fault === "diverged" ||
    state.fault === "paused";
  return (
    <ToolBar className="justify-between">
      <span className="flex min-w-0 items-center gap-1.5 px-1 text-xs">
        <Icon
          className={cn(
            "size-3.5 shrink-0",
            look.tone ?? "text-muted-foreground",
            look.spin && "animate-spin",
          )}
        />
        <span className="truncate">{t(look.label)}</span>
      </span>
      {on && (
        <span className="flex shrink-0 items-center gap-0.5">
          {!stuck && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground [&_svg]:size-3.5"
              title={t("syncNow")}
              aria-label={t("syncNow")}
              disabled={action.busy !== null}
              onClick={() => void action.run("now", () => sync.syncNow())}
            >
              <RefreshCw
                className={cn(action.busy === "now" && "animate-spin")}
              />
            </Button>
          )}
          <LeaveMenu sync={sync} action={action} />
        </span>
      )}
    </ToolBar>
  );
}

/** Stopping here, and turning off for everyone (confirmed in a dialog). */
function LeaveMenu({ sync, action }: { sync: WorkspaceSync; action: Runner }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-muted-foreground [&_svg]:size-3.5"
            title={t("syncMore")}
            aria-label={t("syncMore")}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => void action.run("decline", () => sync.decline())}
          >
            {t("syncStopHere")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => setConfirming(true)}
          >
            {t("syncTurnOff")}…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("syncTurnOffTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("syncTurnOffDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                void action.run("turnOff", () => sync.turnOffForEveryone())
              }
            >
              {t("syncTurnOff")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Where it syncs (repository, then branch) and how it signs in, stacked
 *  so a narrow sidebar never squeezes them into columns. */
function RemoteRows({
  sync,
  state,
}: {
  sync: WorkspaceSync;
  state: SyncState;
}) {
  const { t } = useTranslation();
  const remote = state.remote!;
  return (
    <div data-sync-remote="" className="space-y-2">
      <div className="min-w-0 space-y-0.5">
        <div
          className="truncate"
          title={remote.url}
          aria-label={t("syncRepository")}
        >
          {remoteLabel(remote.url)}
        </div>
        <div
          className="flex min-w-0 items-center gap-1 text-muted-foreground"
          aria-label={t("syncBranch")}
        >
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{remote.branch}</span>
        </div>
      </div>
      <div className="text-muted-foreground" aria-label={t("syncSignIn")}>
        {isSshRemote(remote.url) ? (
          t("syncCredential-ssh")
        ) : (
          <TokenCredential sync={sync} state={state} />
        )}
      </div>
    </div>
  );
}

/** What the state means, or what to fix; what an action hit; and the
 *  buttons, in that order. */
function Message({
  state,
  error,
  children,
}: {
  state: SyncState;
  error: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const text = messageOf(state, t);
  const problem =
    state.setup === "on" &&
    (state.fault === "diverged" || state.fault === "auth-error");
  return (
    <div className="space-y-2">
      {text && (
        <p
          className={cn(
            "leading-snug",
            problem ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {text}
        </p>
      )}
      {error && <p className="leading-snug text-destructive">{error}</p>}
      {children}
    </div>
  );
}

function messageOf(state: SyncState, t: TFunction): string | null {
  switch (state.setup) {
    case "unavailable":
      return state.reason ?? t("syncNotARepository");
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

/** What carries on from here: turning on (or not now), or, from a stop,
 *  what resumes. Running sync needs nothing here (sync now is in the bar). */
function actionsOf(
  sync: WorkspaceSync,
  state: SyncState,
): { key: string; label: string; run: () => unknown }[] {
  if (state.setup === "off" || state.setup === "declined")
    return [{ key: "turnOn", label: "syncTurnOn", run: () => sync.turnOn() }];
  if (state.setup === "ask") {
    return [
      { key: "turnOn", label: "syncTurnOnHere", run: () => sync.turnOn() },
      { key: "decline", label: "syncNotNow", run: () => sync.decline() },
    ];
  }
  // A stop waits on the user, and `syncNow` does nothing until `resume`.
  if (state.fault === "diverged")
    return [{ key: "resume", label: "syncKeepMine", run: () => sync.resume() }];
  if (state.fault === "auth-error")
    return [{ key: "resume", label: "syncRetry", run: () => sync.resume() }];
  if (state.fault === "paused")
    return [{ key: "resume", label: "syncGoOn", run: () => sync.resume() }];
  return [];
}

function Actions({
  sync,
  state,
  action,
}: {
  sync: WorkspaceSync;
  state: SyncState;
  action: Runner;
}) {
  const { t } = useTranslation();
  const actions = actionsOf(sync, state);
  if (actions.length === 0) return null;
  return (
    <div data-sync-actions="" className="flex flex-wrap items-center gap-1.5">
      {actions.map(({ key, label, run }) => (
        <Small
          key={key}
          busy={action.busy === key}
          disabled={action.busy !== null}
          onClick={() => void action.run(key, run)}
        >
          {t(label)}
        </Small>
      ))}
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

/** A quiet inline link, for switching how it signs in. */
function Link({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="text-foreground/80 underline decoration-border underline-offset-2 hover:text-foreground hover:decoration-foreground/40"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** An HTTPS remote's credential, and switching it. */
function TokenCredential({
  sync,
  state,
}: {
  sync: WorkspaceSync;
  state: SyncState;
}) {
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

  if (credential.isPending)
    return (
      <span className="text-muted-foreground">
        {t("syncLookingForCredentials")}
      </span>
    );
  const status = credential.data ?? null;
  return (
    <div className="space-y-1.5">
      <div>
        {status
          ? t(`syncCredential-${status.source}`, { username: status.username })
          : t("syncNoCredentials")}
      </div>
      {status && !pasting && (
        <Link
          onClick={() =>
            status.source === "stored"
              ? void change("switch", () =>
                  platform.credentials.delete(url, repo),
                )
              : setPasting(true)
          }
        >
          {t(
            status.source === "stored"
              ? "syncUseGitCredentials"
              : "syncUseToken",
          )}
        </Link>
      )}
      {(pasting || !status) && (
        <TokenForm
          url={url}
          busy={action.busy === "save"}
          onCancel={status ? () => setPasting(false) : undefined}
          onSave={(token) =>
            change("save", () => platform.credentials.set(url, repo, token))
          }
        />
      )}
      {action.error && <p className="text-destructive">{action.error}</p>}
    </div>
  );
}

function TokenForm({
  url,
  busy,
  onSave,
  onCancel,
}: {
  url: string;
  busy: boolean;
  onSave: (token: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const { platform } = useCore();
  const [token, setToken] = useState("");
  const help = tokenHelp(url);
  return (
    <form
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(token).then(() => setToken(""));
      }}
    >
      <div className="flex items-center gap-1.5">
        <Input
          type="password"
          autoComplete="off"
          className="h-6 min-w-0 flex-1 px-2 text-xs"
          placeholder={t("syncTokenPlaceholder")}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Small type="submit" busy={busy} disabled={!token.trim() || busy}>
          {t("syncSaveToken")}
        </Small>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {help && (
          <Link onClick={() => void platform.ui.openExternal(help)}>
            {t("syncCreateToken")}
          </Link>
        )}
        {onCancel && <Link onClick={onCancel}>{t("cancel")}</Link>}
      </div>
    </form>
  );
}
