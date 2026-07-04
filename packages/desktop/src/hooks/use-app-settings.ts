import { useKv } from "@/utils/kv-store";
import type { Theme } from "@/components/theme-provider";

export const SETTINGS_NAMESPACE = "settings";

export interface AppSettings {
  theme: Theme;
  lastPath: string | null;
  zoomLevel: number;
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: "dark",
  lastPath: null,
  zoomLevel: 1,
};

export function useAppSettings() {
  const { values, set } = useKv<unknown>(SETTINGS_NAMESPACE);

  const settings: AppSettings = {
    theme: (values["theme"] as Theme) ?? DEFAULT_APP_SETTINGS.theme,
    lastPath:
      (values["lastPath"] as string | null) ?? DEFAULT_APP_SETTINGS.lastPath,
    zoomLevel:
      (values["zoomLevel"] as number) ?? DEFAULT_APP_SETTINGS.zoomLevel,
  };

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
    setSetting,
    setTheme,
    setLastPath,
    setZoomLevel,
  } as const;
}
