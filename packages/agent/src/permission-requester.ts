import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@notefig/shared/agent";

/**
 * The requesting surface of the app's permission broker — the only part the
 * protocol layer calls (mcp-server's `dispatchToolCall` gate, acp-client's
 * no-allow-option fallback). Responding and cancelling are app concerns and
 * stay on the concrete broker in desktop.
 */
export interface PermissionRequester {
  request(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>;
}
