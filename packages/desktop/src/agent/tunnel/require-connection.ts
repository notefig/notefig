import { toast } from "sonner";
import i18n from "@/utils/intl";
import { isWeb } from "@/utils/platform";
import { tunnelConnection } from "./tunnel-connection";
import { openPairDialog } from "./pair-dialog-store";

/**
 * Gate agent-start actions on the web having a paired worker. On desktop
 * agents run locally, so this is always true. On web with no live tunnel it
 * shows a snackbar whose action opens the pairing dialog, and returns false
 * so the caller bails instead of letting `createAgentTransport` throw an
 * unsurfaced error. Call this before starting/spawning a task, not for
 * prompts to an already-running one.
 */
export function ensureAgentRuntime(): boolean {
  if (!isWeb()) return true;
  if (tunnelConnection.getState().status === "connected") return true;
  toast.error(i18n.t("tunnelNoConnection"), {
    action: {
      label: i18n.t("tunnelConnectMachine"),
      onClick: () => openPairDialog(),
    },
  });
  return false;
}
