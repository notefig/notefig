import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@notefig/shared/agent";
import type { PermissionRequester } from "@notefig/agent";
import { agentPermissionRequestsCollection } from "./agent-collections";

type Pending = {
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
};

/**
 * Promise-per-request bridge between the ACP client and the permission UI.
 * The queue is published through `agentPermissionRequestsCollection` (the one
 * bus): `request()` inserts a pending row the UI renders via useLiveQuery, and
 * `respond()`/`cancelAll()` settle the awaited promise and update the row.
 * session/cancel must resolve every pending request as cancelled, per the ACP
 * spec.
 */
export class PermissionBroker implements PermissionRequester {
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;

  constructor(private readonly taskId: string) {}

  request(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      // Prefix with taskId so ids are unique across every task's broker (the
      // collection is keyed globally, not per task).
      const id = `${this.taskId}_perm_${++this.nextId}`;
      this.pending.set(id, { request, resolve });
      agentPermissionRequestsCollection.insert({
        id,
        taskId: this.taskId,
        sessionId: request.sessionId,
        title: request.toolCall.title ?? "The agent is requesting permission",
        options: request.options,
        status: "pending",
      });
    });
  }

  respond(id: string, response: RequestPermissionResponse): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(response);
    this.settleRow(id, response);
  }

  /** Resolve all pending requests as cancelled (turn was cancelled). */
  cancelAll(): void {
    for (const [id, entry] of this.pending) {
      const response: RequestPermissionResponse = {
        outcome: { outcome: "cancelled" },
      };
      entry.resolve(response);
      this.settleRow(id, response);
    }
    this.pending.clear();
  }

  /** Reflect the resolution onto the collection row so the UI drops it. */
  private settleRow(id: string, response: RequestPermissionResponse): void {
    if (!agentPermissionRequestsCollection.get(id)) return;
    agentPermissionRequestsCollection.update(id, (draft) => {
      draft.status = statusFor(response);
    });
  }
}

function statusFor(
  response: RequestPermissionResponse,
): "granted" | "denied" | "cancelled" {
  const outcome = response.outcome;
  if (outcome.outcome === "cancelled") return "cancelled";
  // "selected" — allow_* kinds grant, reject_* kinds deny. We don't have the
  // option kind here, so treat any explicit selection as granted; the UI only
  // needs "no longer pending".
  return "granted";
}
