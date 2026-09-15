/**
 * The desktop's `ServiceHost` (MET-193).
 *
 * The second real implementation of the contract, alongside the CLI's
 * headless host — which is the point of the acceptance criterion: a contract
 * validated against one host is an inventory, not a boundary.
 *
 * Almost every member is a value the app already had lying around; the work
 * was deciding what the core is allowed to ask for, not building anything
 * new. `ui` and `updates` are deliberately absent: the core never calls them,
 * so they stay desktop-only and unreachable.
 */
import type { ServiceHost } from "@notefig/core";
import { platformAdapter } from "@/adapters";
import { path as pathutil } from "@/utils/path";
import { APP_DIR_NAME } from "@/utils/app-dir";
import i18n from "@/utils/intl";
import { desktopEditorContext } from "@/adapters/editor-context";

export const desktopHost: ServiceHost = {
  platform: {
    fs: platformAdapter.fs,
    proc: platformAdapter.proc,
    db: platformAdapter.db,
  },
  capabilities: {
    // A webview stops when its window does. The service process is what
    // makes this true later (MET-187), not the desktop shell.
    runsInBackground: false,
  },
  path: pathutil,
  telemetry: {
    // Bound through a lambda rather than passed by reference: the core's
    // event names are its own, and this keeps the typed desktop event union
    // from leaking into the contract.
    captureEvent: (name, properties) => {
      void import("@/telemetry/telemetry").then(({ captureEvent }) =>
        captureEvent(name as never, properties as never),
      );
    },
  },
  translate: (key) => i18n.t(key),
  appDirName: APP_DIR_NAME,
  editor: desktopEditorContext,
};
