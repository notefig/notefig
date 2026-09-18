import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { getDesktopOs } from "@/utils/platform";
import { useAppSettings } from "@/hooks/use-app-settings";

/**
 * Physical pixels the titlebar must cover so content clears the native
 * traffic lights (trafficLightPosition y:14 + ~12px glyphs, plus the 4px
 * pull-up below — see tauri.conf.json).
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

/**
 * Horizontal room the native traffic lights take on macOS (x:14 origin,
 * three 12px lights on 20px centres), in physical pixels — the top bar's
 * content starts after it.
 */
const TRAFFIC_LIGHT_INSET_PX = 78;

/** The bar's height in physical pixels: the traffic lights (y:14, 12px
 *  tall) sit on its centre line, so one row reads as one row. */
const TOP_BAR_HEIGHT_PX = 40;
/** Without traffic lights to centre on, a touch shorter. */
const TOP_BAR_HEIGHT_PLAIN_PX = 34;

/**
 * The window's top bar: the drag region and platform window controls with
 * the app's own chrome laid into it — a single boxy strip above the
 * sidebar and the tabs rather than a bare spacer. Rendered by the
 * workspace shell; `Titlebar` below is the content-less form for screens
 * that have nothing to put there.
 */
export function TopBar({ children }: { children: ReactNode }) {
  const os = getDesktopOs();
  const { settings } = useAppSettings();
  const ref = useTitlebarHeightVar<HTMLDivElement>();
  const zoom = settings.zoomLevel || 1;
  const isMac = os === "macos";

  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="flex w-full shrink-0 select-none items-center border-b border-border"
      style={{
        WebkitAppRegion: "drag",
        // Physical px, divided by the webview zoom: the traffic lights
        // don't scale with the page, so the row that centres on them
        // can't either.
        height: Math.round(
          (isMac ? TOP_BAR_HEIGHT_PX : TOP_BAR_HEIGHT_PLAIN_PX) / zoom,
        ),
        minHeight: isMac
          ? Math.ceil(TRAFFIC_LIGHT_CLEARANCE_PX / zoom)
          : undefined,
        paddingInlineStart: isMac
          ? Math.ceil(TRAFFIC_LIGHT_INSET_PX / zoom)
          : undefined,
      } as React.CSSProperties}
    >
      <div
        className="flex h-full min-w-0 flex-1 items-center"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {children}
      </div>
      {os === "windows" && <WindowsControls />}
    </div>
  );
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
      // -m-1/w-[calc(100%+1rem)] used to do this bleed, but both are
      // rem-based and silently grew (4px -> 6px pull-up) when the root
      // font-size moved to a 150% baseline, eating into
      // TRAFFIC_LIGHT_CLEARANCE_PX's fixed-px budget. Pinned to px so this
      // can't drift again the next time the root scale changes.
      className="texture-surface -m-[4px] w-[calc(100%+8px)] shrink-0 h-[5vh] md:h-[3vh] xl:h-[2.5vh] bg-background"
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
  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="w-full shrink-0 h-5 bg-background flex items-center justify-end select-none"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <WindowsControls />
    </div>
  );
}

/** The minimize / maximize / close cluster, in the bar's own style. */
function WindowsControls() {
  const { t } = useTranslation();

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
      className="flex h-full items-stretch"
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label={t("minimize")}
        onClick={minimize}
        className={buttonClass}
      >
        <Minus size={10} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        aria-label={t("maximize")}
        onClick={toggleMaximize}
        className={buttonClass}
      >
        <Square size={8} strokeWidth={1.5} />
      </button>
      <button
        type="button"
        aria-label={t("close")}
        onClick={close}
        className={`${buttonClass} hover:bg-destructive hover:text-destructive-foreground`}
      >
        <X size={10} strokeWidth={1.5} />
      </button>
    </div>
  );
}
