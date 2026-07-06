import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@metrists/shared/agent";

export type PendingPermission = {
  id: string;
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
};

/**
 * Promise-per-request queue between the ACP client and the permission UI.
 * The UI renders the head of the queue (permission-card.tsx); resolving or
 * cancelling settles the promise the ACP client is awaiting. session/cancel
 * must resolve every pending request as cancelled, per the ACP spec.
 */
export class PermissionBroker {
  private pending = new Map<string, PendingPermission>();
  private listeners = new Set<(pending: PendingPermission[]) => void>();
  private nextId = 0;

  request(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      const id = `perm_${++this.nextId}`;
      this.pending.set(id, { id, request, resolve });
      this.notify();
    });
  }

  respond(id: string, response: RequestPermissionResponse): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    entry.resolve(response);
    this.notify();
  }

  /** Resolve all pending requests as cancelled (turn was cancelled). */
  cancelAll(): void {
    for (const entry of this.pending.values()) {
      entry.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pending.clear();
    this.notify();
  }

  subscribe(listener: (pending: PendingPermission[]) => void): () => void {
    this.listeners.add(listener);
    listener([...this.pending.values()]);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snapshot = [...this.pending.values()];
    for (const listener of this.listeners) listener(snapshot);
  }
}
