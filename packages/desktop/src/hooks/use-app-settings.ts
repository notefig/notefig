import { useLiveQuery } from "@tanstack/react-db";
import {
  getOrCreateSettingsCollection,
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AppSettingRow,
} from "@/utils/collections";
import type { Theme } from "@/components/theme-provider";

export function useAppSettings() {
  const collection = getOrCreateSettingsCollection();

  const { data: rows = [] } = useLiveQuery(
    (q) =>
      q.from({ s: collection }).select(({ s }) => ({
        key: s.key,
        value: s.value,
      })),
    [],
  );

  const settings: AppSettings = { ...DEFAULT_APP_SETTINGS };
  for (const row of rows) {
    if (row.key in DEFAULT_APP_SETTINGS) {
      (settings as unknown as Record<string, unknown>)[row.key] = row.value;
    }
  }

  function setSetting<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ) {
    const existing = collection.get(key as string);
    if (existing) {
      collection.update(key as string, (draft: AppSettingRow) => {
        draft.value = value;
      });
    } else {
      collection.insert({ key: key as string, value });
    }
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
