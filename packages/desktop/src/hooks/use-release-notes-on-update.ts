import { useEffect, useRef } from "react";
import { useCore } from "@notefig/core/react";
import { useAppSettings } from "@/hooks/use-app-settings";
import { RELEASE_NOTES_TAB_ID } from "@/modules/tabs";

/**
 * Opens the release-notes tab once after an app update. `lastSeenVersion`
 * is recorded at injection time — not at tab close — so the tab is added
 * exactly once per version; from then on it lives (or doesn't) in the
 * layout like any other tab. Fresh installs (null) skip the tab and just
 * record the version.
 */
export function useReleaseNotesOnUpdate() {
  const { tabs } = useCore();
  const { settings, isReady, setSetting } = useAppSettings();
  const hasRun = useRef(false);

  useEffect(() => {
    if (!isReady || hasRun.current) return;
    hasRun.current = true;

    if (settings.lastSeenVersion === __APP_VERSION__) return;
    if (settings.lastSeenVersion !== null) {
      tabs.open(RELEASE_NOTES_TAB_ID, { intent: "new-tab" });
    }
    setSetting("lastSeenVersion", __APP_VERSION__);
  }, [isReady, settings.lastSeenVersion, tabs, setSetting]);
}
