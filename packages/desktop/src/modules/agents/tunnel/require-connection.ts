import { toast } from "sonner";
import i18n from "@/utils/intl";
import { isWeb } from "@/utils/platform";
import { tunnelConnection } from "./tunnel-connection";
import { openPairDialog } from "./pair-dialog-store";
import { MOCK_AGENT_MODE } from "../mock-mode";

/**
 * The machine agents run on, for the agents facade: on desktop this one,
 * always reachable; on the web the paired machine, reachable while the
 * tunnel is connected (the mock build needs none).
 */
export const agentRuntimeConnection = {
  connected: (): boolean =>
    MOCK_AGENT_MODE || !isWeb() || tunnelConnection.getState().status === "connected",
  subscribe: (listener: () => void): (() => void) => tunnelConnection.subscribe(listener),
  /** No machine: a snackbar whose action opens the pairing dialog. */
  explain: (): void => {
    toast.error(i18n.t("tunnelNoConnection"), {
      action: {
        label: i18n.t("tunnelConnectMachine"),
        onClick: () => openPairDialog(),
      },
    });
  },
};
