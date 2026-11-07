/**
 * Settings → Sync, for the focused workspace: turn sync on for a clone with
 * an HTTPS remote (pick the remote, paste a token, check access), see its
 * state, and turn it off (offering to delete the token).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@notefig/ui/button";
import { Input } from "@notefig/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@notefig/ui/select";
import { useCore, useWorkspaceModule } from "@notefig/core/react";
import { useFocusedWorkspace } from "@/modules/workspaces/react";
import { useSyncCapabilities } from "@/modules/sync/react";
import {
  cleanRemoteUrl,
  defaultTokenUsername,
  isHttpsRemote,
  readRepoInfo,
  tokenCreationHelp,
  type RepoInfo,
  type SyncFailsafe,
  type WorkspaceSync,
} from "@/modules/sync";
import { turnOffSync, turnOnSync } from "@/modules/sync/turn-on";
import { PRESENCE_COLORS } from "@/modules/sync/presence-identity";
import { cn } from "@notefig/ui/utils";

export function SyncSettings() {
  const workspacePath = useFocusedWorkspace();
  const { platform } = useCore();
  if (!platform.gitHttp.supported || !platform.credentials.supported) {
    return <Note>Sync is available in the Notefig desktop app.</Note>;
  }
  if (!workspacePath) return <Note>Open a workspace to set up sync.</Note>;
  return <WorkspaceSyncSettings key={workspacePath} workspacePath={workspacePath} />;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

function WorkspaceSyncSettings({ workspacePath }: { workspacePath: string }) {
  const { platform } = useCore();
  const sync = useWorkspaceModule(workspacePath, "sync");
  const capabilities = useSyncCapabilities(workspacePath);
  const repo = useQuery({
    queryKey: ["sync-repo-info", workspacePath],
    queryFn: () => readRepoInfo(platform.fs, workspacePath),
  });
  if (!sync || repo.isLoading) return <Note>Loading…</Note>;
  if (capabilities.active) return <SyncOnPanel sync={sync} />;
  return <SyncSetup sync={sync} repo={repo.data ?? null} />;
}

const DESCRIPTION =
  "Keep this workspace in step with a branch of its git remote: your edits are committed and pushed after a pause, and changes pushed by others appear in your open documents. The token stays in your system keychain; Notefig never shows it to agents.";

function SyncSetup({ sync, repo }: { sync: WorkspaceSync; repo: RepoInfo | null }) {
  const remotes = (repo?.remotes ?? []).filter((remote) => isHttpsRemote(remote.url));
  if (!repo) {
    return <Note>This workspace isn't a git clone. Sync needs a folder cloned from an HTTPS remote.</Note>;
  }
  if (remotes.length === 0) {
    return <Note>This repository has no HTTPS remote. Sync works with HTTPS remotes only (not SSH).</Note>;
  }
  if (!repo.branch) {
    return <Note>Check out a branch first: sync follows the checked-out branch.</Note>;
  }
  return <SyncSetupForm sync={sync} repo={repo} remotes={remotes} branch={repo.branch} />;
}

function SyncSetupForm({
  sync,
  repo,
  remotes,
  branch,
}: {
  sync: WorkspaceSync;
  repo: RepoInfo;
  remotes: RepoInfo["remotes"];
  branch: string;
}) {
  const { platform } = useCore();
  const [remoteName, setRemoteName] = useState(remotes[0].name);
  const remote = cleanRemoteUrl(remotes.find((r) => r.name === remoteName)!.url);
  const [token, setToken] = useState("");
  const [name, setName] = useState(repo.author?.name ?? "");
  const [email, setEmail] = useState(repo.author?.email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const help = tokenCreationHelp(remote);

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await turnOnSync(
        { sync, credentials: platform.credentials },
        {
          remote,
          branch,
          username: defaultTokenUsername(remote),
          token,
          author: name && email ? { name, email } : undefined,
        },
      );
      if (!result.ok) setError(result.message);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      setToken("");
    }
  };

  return (
    <div className="space-y-3" data-testid="sync-setup">
      <Note>{DESCRIPTION}</Note>
      <Field label="Remote">
        <Select value={remoteName} onValueChange={setRemoteName}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {remotes.map((r) => (
              <SelectItem key={r.name} value={r.name}>
                {r.name} — {cleanRemoteUrl(r.url)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Branch">
        <span className="text-sm">{branch} (the checked-out branch)</span>
      </Field>
      <Field label="Access token">
        <Input
          type="password"
          autoComplete="off"
          placeholder="Paste a personal access token"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">
          {help.permissions}{" "}
          {help.href && (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-primary hover:underline"
              onClick={() => void platform.ui.openExternal(help.href!)}
            >
              Create one <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </p>
      </Field>
      <Field label="Commit as">
        <div className="flex gap-2">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
      </Field>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button onClick={() => void turnOn()} disabled={busy}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />}
        {busy ? "Checking access…" : "Turn on sync"}
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{label}</h3>
      {children}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  synced: "Synced",
  committing: "Committing your changes…",
  pulling: "Bringing in remote changes…",
  pushing: "Pushing…",
  offline: "Offline — retrying",
  throttled: "The host is rate limiting — retrying later",
  "auth-error": "The token was refused",
  diverged: "Stopped",
  failsafe: "Stopped to keep your work safe",
};

const FAILSAFE_TEXT: Record<SyncFailsafe["reason"], string> = {
  unrelated: "The remote branch was rewritten (force-pushed), so there is nothing to merge onto.",
  validation: "A merge produced a document Notefig couldn't vouch for.",
  divergence:
    "Edits made while offline overlap too much of what others changed meanwhile to merge them blindly.",
};

/** The failsafe's choice. The local state is already on a recovery ref. */
function FailsafeChoice({
  sync,
  failsafe,
  onTurnOff,
}: {
  sync: WorkspaceSync;
  failsafe: SyncFailsafe;
  onTurnOff: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    setBusy(true);
    try {
      await sync.acceptIncoming();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded border border-destructive/40 p-3" data-testid="sync-failsafe">
      <p className="text-sm">{FAILSAFE_TEXT[failsafe.reason]}</p>
      <Note>
        Nothing is lost: your local version is saved on the local ref {failsafe.recoveryRef},
        which is never pushed. Take the remote's version of every file, or turn sync off and
        keep your files as they are.
      </Note>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void accept()} disabled={busy}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          Accept all incoming
        </Button>
        <Button variant="outline" onClick={onTurnOff} disabled={busy}>
          Turn sync off
        </Button>
      </div>
    </div>
  );
}

function SyncOnPanel({ sync }: { sync: WorkspaceSync }) {
  const { platform } = useCore();
  const capabilities = useSyncCapabilities(sync.workspacePath);
  const config = sync.config();
  const [confirmingOff, setConfirmingOff] = useState(false);
  const turnOff = (deleteToken: boolean) =>
    void turnOffSync({ sync, credentials: platform.credentials }, { deleteToken });

  return (
    <div className="space-y-3" data-testid="sync-on">
      <p className="text-sm">
        <span className="font-medium">{STATUS_TEXT[capabilities.status]}</span>
        {config && (
          <span className="text-muted-foreground"> · {config.branch} on {config.remote}</span>
        )}
      </p>
      {capabilities.detail && (
        <p className="text-sm text-muted-foreground">{capabilities.detail}</p>
      )}
      {capabilities.failsafe && (
        <FailsafeChoice
          sync={sync}
          failsafe={capabilities.failsafe}
          onTurnOff={() => turnOff(false)}
        />
      )}
      {capabilities.status === "diverged" && (
        <Note>
          Nothing was overwritten: the remote's version is on the branch, and your local
          files are as you left them. Resume to commit your files over it, or turn sync off.
        </Note>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void sync.syncNow()} disabled={!capabilities.commits}>
          Sync now
        </Button>
        {capabilities.canResume && (
          <Button variant="outline" onClick={() => sync.resume()}>
            Resume
          </Button>
        )}
        {!confirmingOff ? (
          <Button variant="outline" onClick={() => setConfirmingOff(true)}>
            Turn off sync
          </Button>
        ) : (
          <>
            <Button variant="destructive" onClick={() => turnOff(true)}>
              Turn off and delete token
            </Button>
            <Button variant="outline" onClick={() => turnOff(false)}>
              Turn off, keep token
            </Button>
          </>
        )}
      </div>
      {capabilities.status === "auth-error" && <ReplaceToken sync={sync} />}
      <PresenceIdentity sync={sync} />
    </div>
  );
}

/** How this device appears to collaborators: a name and a colour (its
 *  agents carry the same colour, with an agent marker). */
function PresenceIdentity({ sync }: { sync: WorkspaceSync }) {
  const identity = sync.identity();
  const [name, setName] = useState(identity?.settings.name ?? "");
  const [color, setColor] = useState(identity?.settings.color ?? "");
  if (!identity) return null;
  const shown = color || identity.color;
  const save = (next: { name?: string; color?: string }) =>
    void sync.setIdentity({ name: next.name ?? name, color: next.color ?? color });
  return (
    <div className="space-y-2 border-t border-border pt-3" data-testid="sync-identity">
      <p className="text-sm font-medium">How others see you</p>
      <Field label="Name">
        <Input
          value={name}
          placeholder={identity.settings.name ? undefined : identity.name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => save({})}
        />
      </Field>
      <Field label="Colour">
        <div className="flex flex-wrap items-center gap-1.5">
          {PRESENCE_COLORS.map((swatch) => (
            <button
              key={swatch}
              type="button"
              aria-label={`Colour ${swatch}`}
              aria-pressed={shown === swatch}
              onClick={() => {
                setColor(swatch);
                save({ color: swatch });
              }}
              className={cn(
                "h-5 w-5 rounded-full ring-offset-2 ring-offset-background",
                shown === swatch && "ring-2 ring-foreground",
              )}
              style={{ backgroundColor: swatch }}
            />
          ))}
          {color && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setColor("");
                save({ color: "" });
              }}
            >
              Reset
            </Button>
          )}
        </div>
      </Field>
      <p className="text-xs text-muted-foreground">
        Shown next to your cursor and in the list of people here. Your agents appear in the same
        colour.
      </p>
    </div>
  );
}

function ReplaceToken({ sync }: { sync: WorkspaceSync }) {
  const { platform } = useCore();
  const [token, setToken] = useState("");
  const config = sync.config();
  if (!config) return null;
  const save = async () => {
    await turnOnSync(
      { sync, credentials: platform.credentials },
      {
        remote: config.remote,
        branch: config.branch,
        username: defaultTokenUsername(config.remote),
        token,
        author: config.author,
      },
    );
    setToken("");
  };
  return (
    <Field label="New token">
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Button onClick={() => void save()} disabled={!token.trim()}>
          Save and retry
        </Button>
      </div>
    </Field>
  );
}
