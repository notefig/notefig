import { getDesktopOs } from "@/utils/platform";
import { useAppSettings } from "@/hooks/use-app-settings";

/**
 * Physical pixels the titlebar must cover so content clears the native
 * traffic lights (trafficLightPosition y:14 + ~12px glyphs, plus the -m-1
 * pull-up — see tauri.conf.json).
 */
const TRAFFIC_LIGHT_CLEARANCE_PX = 30;

export function Titlebar() {
  const { settings } = useAppSettings();

  // The spacer only exists to clear the macOS overlay traffic lights; on
  // Windows/Linux the window has native decorations (the macOS-only
  // titleBarStyle/trafficLightPosition config keys are ignored there).
  if (getDesktopOs() !== "macos") return null;

  // Native webview zoom scales CSS pixels but not the traffic lights, so
  // the clearance floor must be divided by the zoom factor.
  const minHeight = Math.ceil(
    TRAFFIC_LIGHT_CLEARANCE_PX / (settings.zoomLevel || 1),
  );

  return (
    <div
      data-tauri-drag-region
      className="texture-surface -m-1 w-[calc(100%+1rem)] shrink-0 h-[5vh] md:h-[3vh] xl:h-[2.5vh] bg-background"
      style={
        { WebkitAppRegion: "drag", minHeight } as React.CSSProperties
      }
    />
  );
}
