/**
 * The web build has no git HTTP transport (CORS) and no keychain: sync is
 * desktop-only until MET-275. Both surfaces say so and reject.
 */
import {
  PlatformUnsupportedError,
  type CredentialsSurface,
  type GitHttpSurface,
} from "./platform-adapter.interface";

const unsupported = () =>
  Promise.reject(
    new PlatformUnsupportedError("Sync is available in the desktop app only."),
  );

export function createUnsupportedGitHttp(): GitHttpSurface {
  return { supported: false, request: unsupported };
}

export function createUnsupportedCredentials(): CredentialsSurface {
  return {
    supported: false,
    set: unsupported,
    has: unsupported,
    delete: unsupported,
  };
}
