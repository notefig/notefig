import type { PendingPermission } from "@/agent/permission-broker";

/**
 * Renders the head of the PermissionBroker queue: the agent-provided options
 * verbatim (per ACP), plus a remembered-choice affordance stored per
 * workspace + tool kind in KV.
 */
export type PermissionCardProps = {
  permission: PendingPermission;
  onRespond: (optionId: string) => void;
};

export function PermissionCard({ permission }: PermissionCardProps) {
  // TODO(phase 1): option buttons from permission.request.options.
  return <div>Permission request {permission.id} (not implemented)</div>;
}
