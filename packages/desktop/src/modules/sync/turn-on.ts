/**
 * Turning sync on and off for a workspace, as the settings section does it:
 * store the token (Rust keeps it; JS never reads it back), check read and
 * push access, then write sync.json and start. Pure orchestration over
 * what it is handed.
 */
import type { CredentialsSurface } from "@/adapters/platform-adapter.interface";
import { remoteCredentialKey, type SyncAuthor } from "./sync-config";
import type { WorkspaceSync } from "./sync";
import type { SyncStepError } from "./sync-types";

export interface TurnOnInput {
  remote: string;
  branch: string;
  /** Basic-auth username for the token (`x-access-token`, `oauth2`…). */
  username: string;
  /** Empty: use the token already stored for this remote. */
  token: string;
  author?: SyncAuthor;
}

export type TurnOnResult = { ok: true } | { ok: false; message: string };

/** What a failed access check tells the user. */
export function accessMessage(error: SyncStepError, remote: string): string {
  const where = remoteCredentialKey(remote);
  switch (error.code) {
    case "AuthRequired":
    case "AuthFailed":
      return `The token was refused. Check that it is still valid and can access ${where}.`;
    case "RepoNotFound":
      return `${where} was not found, or the token can't see it.`;
    case "Network":
      return `Couldn't reach ${new URL(remote).host}. Check the connection and try again.`;
    case "Throttled":
      return "The host is rate limiting requests. Try again in a minute.";
    default:
      return error.message;
  }
}

export async function turnOnSync(
  deps: {
    sync: Pick<WorkspaceSync, "verify" | "enable">;
    credentials: Pick<CredentialsSurface, "set" | "has">;
  },
  input: TurnOnInput,
): Promise<TurnOnResult> {
  const key = remoteCredentialKey(input.remote);
  const token = input.token.trim();
  if (token) {
    await deps.credentials.set(key, input.username, token);
  } else if (!(await deps.credentials.has(key))) {
    return { ok: false, message: "Paste a token for this remote first." };
  }
  const verified = await deps.sync.verify({
    remote: input.remote,
    branch: input.branch,
  });
  if (!verified.ok) {
    return { ok: false, message: accessMessage(verified.error, input.remote) };
  }
  if (!verified.value.canPush) {
    return {
      ok: false,
      message: "This token can read the repository but not push to it. Give it write access to the repository's contents.",
    };
  }
  await deps.sync.enable({
    remote: input.remote,
    branch: input.branch,
    ...(input.author ? { author: input.author } : {}),
  });
  return { ok: true };
}

/** Turn sync off; the token goes too when asked. */
export async function turnOffSync(
  deps: {
    sync: Pick<WorkspaceSync, "disable" | "config">;
    credentials: Pick<CredentialsSurface, "delete">;
  },
  options: { deleteToken: boolean },
): Promise<void> {
  const remote = deps.sync.config()?.remote;
  await deps.sync.disable();
  if (options.deleteToken && remote) {
    await deps.credentials.delete(remoteCredentialKey(remote));
  }
}
