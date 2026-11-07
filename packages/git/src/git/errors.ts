import { GitError, type GitErrorCode } from "./types";

function field(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

/** An HTTP status carried by our transport error or isomorphic-git's `HttpError`. */
function httpStatus(error: unknown): number | undefined {
  const status =
    field(error, "status") ?? field(field(error, "data"), "statusCode");
  return typeof status === "number" ? status : undefined;
}

function codeForStatus(status: number): GitErrorCode {
  switch (status) {
    case 401:
      return "AuthRequired";
    case 403:
      return "AuthFailed";
    case 404:
      return "RepoNotFound";
    case 429:
      return "Throttled";
    default:
      return status >= 500 ? "Network" : "RemoteError";
  }
}

const CODE_BY_NAME: Record<string, GitErrorCode> = {
  NotFoundError: "RepoNotFound",
  FastForwardError: "NotFastForward",
  PushRejectedError: "NotFastForward",
  GitTransportError: "Network",
  PushOutcomeUnknownError: "PushOutcomeUnknown",
  MissingCapabilityError: "UnsupportedOperation",
};

/** Classify anything thrown by isomorphic-git or the smart-HTTP client. */
export function toGitError(error: unknown): GitError {
  if (error instanceof GitError) {
    return error;
  }
  const name = String(field(error, "name") ?? "Error");
  const message = String(field(error, "message") ?? "Unknown git error");

  if (name in CODE_BY_NAME) {
    return new GitError(CODE_BY_NAME[name], message, error);
  }
  const status = httpStatus(error);
  if (
    status !== undefined &&
    (name === "GitHttpStatusError" || name === "HttpError")
  ) {
    return new GitError(codeForStatus(status), message, error);
  }
  if (name === "RemoteProtocolError") {
    return new GitError("RemoteError", message, error);
  }
  return new GitError("CorruptRepository", message, error);
}
