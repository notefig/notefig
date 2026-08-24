import { useLayoutEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { getDesktopOs } from "@/utils/platform";
import { useAppSettings } from "@/hooks/use-app-settings";

/**
 * Physical pixels the titlebar must cover so content clears the native
 * traffic lights (trafficLightPosition y:14 + ~12px glyphs, plus the -m-1
 * pull-up — see tauri.conf.json).
 */
const TRAFFIC_LIGHT_CLEARANCE_PX = 30;

/**
 * Measures the titlebar's own rendered height onto a CSS var on the root
 * element, so anything below it (e.g. Welcome, which otherwise assumes it
 * owns the full viewport) can size itself as `calc(100vh - var(--titlebar-height))`
 * instead of clipping by exactly the titlebar's height.
 */
function useTitlebarHeightVar<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    const setVar = (px: number) =>
      document.documentElement.style.setProperty(
        "--titlebar-height",
        `${px}px`,
      );
    if (!el) {
      setVar(0);
      return;
    }
    setVar(el.offsetHeight);
    const observer = new ResizeObserver(() => setVar(el.offsetHeight));
    observer.observe(el);
    return () => {
      observer.disconnect();
      setVar(0);
    };
  }, []);

  return ref;
}

export function Titlebar() {
  const os = getDesktopOs();

  if (os === "windows") return <WindowsTitlebar />;

  // On Linux the window has native decorations (the macOS-only
  // titleBarStyle/trafficLightPosition config keys are ignored there).
  if (os !== "macos") return <NoTitlebar />;

  return <MacTitlebarSpacer />;
}

// Keeps --titlebar-height at 0 when there's no rendered titlebar at all
// (Linux, or web).
function NoTitlebar() {
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--titlebar-height", "0px");
  }, []);
  return null;
}

function MacTitlebarSpacer() {
  const { settings } = useAppSettings();
  const ref = useTitlebarHeightVar<HTMLDivElement>();

  // Native webview zoom scales CSS pixels but not the traffic lights, so
  // the clearance floor must be divided by the zoom factor.
  const minHeight = Math.ceil(
    TRAFFIC_LIGHT_CLEARANCE_PX / (settings.zoomLevel || 1),
  );

  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="texture-surface -m-1 w-[calc(100%+1rem)] shrink-0 h-[5vh] md:h-[3vh] xl:h-[2.5vh] bg-background"
      style={{ WebkitAppRegion: "drag", minHeight } as React.CSSProperties}
    />
  );
}

// Windows gets decorations: false (tauri.windows.conf.json) so the native
// title bar never shows; this renders the drag region + a slim
// minimize/maximize/close cluster in its place. Kept deliberately
// low-contrast (no border, background matches the app) so it reads as part
// of the app's own chrome rather than a bolted-on OS title bar.
function WindowsTitlebar() {
  const ref = useTitlebarHeightVar<HTMLDivElement>();

  async function minimize() {
    await getCurrentWindow().minimize();
  }

  async function toggleMaximize() {
    await getCurrentWindow().toggleMaximize();
  }

  async function close() {
    await getCurrentWindow().close();
  }

  const buttonClass =
    "h-full w-8 flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors";

  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="w-full shrink-0 h-5 bg-background flex items-center justify-end select-none"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div
        className="flex h-full items-stretch"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <button
          type="button"
          aria-label="Minimize"
          onClick={minimize}
          className={buttonClass}
        >
          <Minus size={10} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label="Maximize"
          onClick={toggleMaximize}
          className={buttonClass}
        >
          <Square size={8} strokeWidth={1.5} />
        </button>
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className={`${buttonClass} hover:bg-destructive hover:text-destructive-foreground`}
        >
          <X size={10} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
