/**
 * The focused workspace's git remote in the status bar: a Push cell that
 * opens a popover with the branch, the credential a push uses, and the
 * button. Hidden unless the folder is a git repo.
 *
 * The credential is one query that each change replaces in place, so
 * switching between a token and git's credentials never flashes.
 */
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CloudUpload, Loader2 } from "lucide-react";
import { Button } from "@notefig/ui/button";
import { Input } from "@notefig/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@notefig/ui/popover";
import { useCore, useWorkspaceModule } from "@notefig/core/react";
import type { CredentialStatus } from "@/adapters/platform-adapter.interface";
import type { WorkspaceGitRemote } from "@/modules/git-remote";

export function GitRemoteCell({ workspacePath }: { workspacePath: string | null }) {
  const { t } = useTranslation();
  const remote = useWorkspaceModule(workspacePath, "gitRemote");
  const available = useQuery({
    queryKey: ["git-remote-available", workspacePath],
    queryFn: () => remote!.available(),
    enabled: Boolean(remote),
  });
  if (!remote || !available.data) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-testid="git-remote" className="flex items-center gap-1.5 hover:text-foreground">
          <CloudUpload className="h-3.5 w-3.5" />
          <span>{t("gitRemotePush")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 space-y-3 p-3 text-xs">
        <GitRemotePanel remote={remote} workspacePath={workspacePath!} />
      </PopoverContent>
    </Popover>
  );
}

export function GitRemotePanel({ remote, workspacePath }: { remote: WorkspaceGitRemote; workspacePath: string }) {
  const { t } = useTranslation();
  const target = useQuery({
    queryKey: ["git-remote-target", workspacePath],
    queryFn: () => remote.target(),
    staleTime: 0,
  });
  const push = useMutation({ mutationFn: () => remote.push() });

  if (!target.data) return <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />;
  if ("problem" in target.data) return <p className="text-muted-foreground">{target.data.problem}</p>;
  const { url, branch } = target.data;
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{branch}</span>
        <span className="truncate text-muted-foreground">{url.replace(/^https:\/\//, "").replace(/\.git$/, "")}</span>
      </div>
      <Credential url={url} />
      {push.error && <p className="text-destructive">{push.error.message}</p>}
      {push.data && <p className="text-muted-foreground">{t(push.data === "pushed" ? "gitRemotePushed" : "gitRemoteUpToDate")}</p>}
      <Button size="sm" disabled={push.isPending} onClick={() => push.mutate()}>
        {push.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
        {t("gitRemotePush")}
      </Button>
    </>
  );
}

/** Where to create a token with only what a push needs. */
function tokenHelp(url: string): string | null {
  const { host, pathname } = new URL(url);
  if (host === "github.com") {
    const owner = pathname.split("/")[1] ?? "";
    return `https://github.com/settings/personal-access-tokens/new?name=Notefig&target_name=${owner}&contents=write`;
  }
  if (host.includes("gitlab")) {
    return `https://${host}/-/user_settings/personal_access_tokens?name=Notefig&scopes=read_repository,write_repository`;
  }
  return null;
}

/** The credential a push uses, and switching it. */
function Credential({ url }: { url: string }) {
  const { t } = useTranslation();
  const { platform } = useCore();
  const queryClient = useQueryClient();
  const queryKey = ["git-credential", url];
  const credential = useQuery({
    queryKey,
    queryFn: () => platform.credentials.status(url),
    staleTime: Infinity,
  });
  const [pasting, setPasting] = useState(false);
  const change = useMutation({
    mutationFn: (work: () => Promise<CredentialStatus | null>) => work(),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKey, status);
      setPasting(false);
    },
  });

  if (credential.isPending) return <p className="text-muted-foreground">{t("gitRemoteLookingForCredentials")}</p>;
  const status = credential.data ?? null;
  const toggle = () =>
    status?.source === "stored" ? change.mutate(() => platform.credentials.delete(url)) : setPasting(!pasting);
  return (
    <div className="space-y-1.5">
      <p className="text-muted-foreground">
        {status ? t(`gitRemoteCredential-${status.source}`, { username: status.username }) : t("gitRemoteNoCredentials")}{" "}
        {status && <TextButton onClick={toggle}>{t(status.source === "stored" ? "gitRemoteUseGit" : "gitRemoteUseToken")}</TextButton>}
      </p>
      {(pasting || !status) && (
        <TokenForm
          url={url}
          busy={change.isPending}
          onSave={(token) => change.mutate(() => platform.credentials.set(url, token))}
        />
      )}
      {change.error && <p className="text-destructive">{String(change.error)}</p>}
    </div>
  );
}

function TokenForm({ url, busy, onSave }: { url: string; busy: boolean; onSave: (token: string) => void }) {
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
          onSave(token);
          setToken("");
        }}
      >
        <Input
          type="password"
          autoComplete="off"
          className="h-7 text-xs"
          placeholder={t("gitRemoteTokenPlaceholder")}
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Button size="sm" type="submit" disabled={!token.trim() || busy}>
          {t("gitRemoteSaveToken")}
        </Button>
      </form>
      {help && <TextButton onClick={() => void platform.ui.openExternal(help)}>{t("gitRemoteCreateToken")}</TextButton>}
    </>
  );
}

function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="underline-offset-2 hover:text-foreground hover:underline" onClick={onClick}>
      {children}
    </button>
  );
}
