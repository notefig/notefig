/**
 * The complete catalog of telemetry events. Every event and property is
 * documented in TELEMETRY.md — keep the two in sync. Adding an event here
 * without documenting it there is a review error.
 *
 * Properties must stay coarse: never file paths, workspace names, document
 * content, or anything derived from them.
 */
export type TelemetryEvent =
  | { name: "app_opened"; properties?: undefined }
  | { name: "workspace_opened"; properties: { is_new: boolean } }
  | { name: "agent_turn_started"; properties: { harness: string } }
  | {
      name: "agent_turn_completed";
      properties: {
        harness: string;
        duration_bucket: DurationBucket;
        outcome: "ok" | "error" | "cancelled";
      };
    }
  | { name: "tunnel_paired"; properties?: undefined }
  | { name: "update_available"; properties: { to_version: string } }
  | { name: "update_download_started"; properties: { to_version: string } }
  | { name: "update_download_completed"; properties: { to_version: string } }
  | {
      name: "update_failed";
      properties: { stage: "download" | "restart"; to_version: string };
    }
  | { name: "settings_changed"; properties: { setting: string } }
  | {
      name: "telemetry_consent_answered";
      properties: { crash_enabled: boolean; analytics_enabled: boolean };
    };

export type TelemetryEventName = TelemetryEvent["name"];

export type DurationBucket =
  | "<10s"
  | "10s-1m"
  | "1m-5m"
  | "5m-15m"
  | ">15m";

export function toDurationBucket(ms: number): DurationBucket {
  if (ms < 10_000) return "<10s";
  if (ms < 60_000) return "10s-1m";
  if (ms < 300_000) return "1m-5m";
  if (ms < 900_000) return "5m-15m";
  return ">15m";
}
