import { useKv } from "@/utils/kv-store";
import type { Theme } from "@/components/theme-provider";

export const SETTINGS_NAMESPACE = "settings";

/**
 * Bumped when the telemetry policy changes enough that existing users
 * should be re-prompted. Consent is "answered" when the stored
 * telemetryConsentVersion is >= this value.
 */
export const CURRENT_TELEMETRY_CONSENT_VERSION = 1;

export interface AppSettings {
  theme: Theme;
  lastPath: string | null;
  zoomLevel: number;
  crashReportingEnabled: boolean;
  analyticsEnabled: boolean;
  autoUpdateEnabled: boolean;
  telemetryConsentVersion: number;
  telemetryInstallId: string | null;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "dark",
  lastPath: null,
  zoomLevel: 1,
  crashReportingEnabled: true,
  analyticsEnabled: true,
  autoUpdateEnabled: true,
  telemetryConsentVersion: 0,
  telemetryInstallId: null,
};

function mergeWithDefaults(values: Record<string, unknown>): AppSettings {
  const settings = { ...DEFAULT_APP_SETTINGS };
  for (const key of Object.keys(DEFAULT_APP_SETTINGS) as (keyof AppSettings)[]) {
    const stored = values[key];
    if (stored !== undefined && stored !== null) {
      (settings as Record<string, unknown>)[key] = stored;
    }
  }
  return settings;
}

export function useAppSettings() {
  const { values, set, isReady } = useKv<unknown>(SETTINGS_NAMESPACE);

  const settings = mergeWithDefaults(values);

  function setSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) {
    set(key as string, value);
  }

  function setTheme(theme: Theme) {
    setSetting("theme", theme);
  }

  function setLastPath(path: string | null) {
    setSetting("lastPath", path);
  }

  function setZoomLevel(zoom: number) {
    setSetting("zoomLevel", zoom);
  }

  return {
    settings,
    isReady,
    setSetting,
    setTheme,
    setLastPath,
    setZoomLevel,
  } as const;
}
