/**
 * Who this device is to the others in a sync workspace (MET-272): the name
 * and colour its presence carries. Both are local settings in sync.json
 * (`presence`), editable in Settings → Sync. Without them the name is the
 * commit author's (sync.json's, else the repo's `user.name`) and the
 * colour is picked from the device id, so each clone keeps one colour.
 * A user's agents carry the user's colour, with an agent marker.
 */

/** Distinct on light and dark backgrounds. */
export const PRESENCE_COLORS = [
  "#e5484d",
  "#f76b15",
  "#d4a017",
  "#46a758",
  "#12a594",
  "#0090ff",
  "#3e63dd",
  "#8e4ec6",
  "#d6409f",
  "#a18072",
] as const;

/** The presence name and colour, as sync.json keeps them (each optional). */
export interface SyncPresenceSettings {
  name?: string;
  color?: string;
}

export const PRESENCE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** A device's default colour: the same id always gives the same colour. */
export function defaultPresenceColor(deviceId: string): string {
  let hash = 2166136261;
  for (let i = 0; i < deviceId.length; i++) {
    hash ^= deviceId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return PRESENCE_COLORS[(hash >>> 0) % PRESENCE_COLORS.length];
}

/** The name and colour this device shows, from its settings and fallbacks. */
export function resolvePresenceIdentity(input: {
  deviceId: string;
  settings?: SyncPresenceSettings;
  authorName?: string | null;
}): { name: string; color: string } {
  const name = input.settings?.name?.trim() || input.authorName?.trim() || "Notefig user";
  const color =
    input.settings?.color && PRESENCE_COLOR_PATTERN.test(input.settings.color)
      ? input.settings.color
      : defaultPresenceColor(input.deviceId);
  return { name, color };
}
