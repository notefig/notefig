import {
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { cn } from "@notefig/ui/utils";
import { getDesktopOs, isTauri } from "@/utils/platform";
import { useAppSettings } from "@/hooks/use-app-settings";

/*
 * The native macOS traffic lights are positioned by tauri.conf.json
 * (`trafficLightPosition`) in PHYSICAL pixels from the window's top-left,
 * and they do not scale with the webview zoom. Everything here that has
 * to line up with them is therefore a physical-pixel budget divided by
 * the zoom factor, never a rem — the one place the rem-only sizing rule
 * is broken on purpose. Change these together with the config.
 *
 * The config only fixes x; where the glyphs land vertically, and how wide
 * the cluster runs, is AppKit's per-macOS-version layout (macOS 26 draws
 * 14pt buttons on a 23pt pitch, 11–15 drew 12pt on 20pt). So the shell asks
 * Rust (traffic_lights.rs) to pin the glyphs' centre on its header midline
 * and lays out from the rect Rust measures back; the constants below are
 * only the pre-measurement fallback (macOS 15 numbers).
 */

/** `trafficLightPosition.x/y` from tauri.conf.json. */
const TRAFFIC_LIGHT_X_PX = 21;
const TRAFFIC_LIGHT_Y_PX = 29;
/**
 * Where the glyphs landed relative to that origin on macOS 15, measured on
 * a window capture (`screencapture -l <id>`, 2026-09-21): the close glyph's
 * left edge ~2px right of x and its centre ~1.5px below y.
 */
const TRAFFIC_LIGHT_GLYPH_DX_PX = 2;
const TRAFFIC_LIGHT_GLYPH_CENTRE_DY_PX = 1.5;
/** Three 12px glyphs on 20px centres (macOS 15). */
const TRAFFIC_LIGHT_GLYPH_PX = 12;
const TRAFFIC_LIGHT_SPAN_PX = 52;

/**
 * The shell's outer padding: the floating cards sit this far in from the
 * window edge. The sidebar's header card starts here, so the lights land
 * inside it.
 */
const SHELL_PADDING_PX = 12;
/** The card's border, which the header row sits inside. */
const SHELL_CARD_BORDER_PX = 1;
/**
 * The header row's height. The lights centre on it:
 * SHELL_PADDING_PX + SHELL_CARD_BORDER_PX + HEADER/2
 *   == TRAFFIC_LIGHT_Y_PX + TRAFFIC_LIGHT_GLYPH_CENTRE_DY_PX  (12+1+18 ≈ 29+1.5)
 */
const SHELL_HEADER_HEIGHT_PX = 36;
/** The header row's midline: where Rust pins the glyphs' centre. */
const TRAFFIC_LIGHT_CENTRE_Y_PX =
  SHELL_PADDING_PX + SHELL_CARD_BORDER_PX + SHELL_HEADER_HEIGHT_PX / 2;
/** Breathing room between the last light and the workspace name. */
const TRAFFIC_LIGHT_GAP_PX = 12;
/** Air under the lights on a content-less spacer. */
const TRAFFIC_LIGHT_CLEARANCE_GAP_PX = 4;

/**
 * The lights' bounding box in physical pixels from the window's top-left,
 * as `place_traffic_lights` (traffic_lights.rs) measures it after pinning.
 */
export interface TrafficLightsRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** What the lights looked like before Rust has measured them (macOS 15). */
const FALLBACK_TRAFFIC_LIGHTS: TrafficLightsRect = {
  left: TRAFFIC_LIGHT_X_PX + TRAFFIC_LIGHT_GLYPH_DX_PX,
  right: TRAFFIC_LIGHT_X_PX + TRAFFIC_LIGHT_GLYPH_DX_PX + TRAFFIC_LIGHT_SPAN_PX,
  top:
    TRAFFIC_LIGHT_Y_PX +
    TRAFFIC_LIGHT_GLYPH_CENTRE_DY_PX -
    TRAFFIC_LIGHT_GLYPH_PX / 2,
  bottom:
    TRAFFIC_LIGHT_Y_PX +
    TRAFFIC_LIGHT_GLYPH_CENTRE_DY_PX +
    TRAFFIC_LIGHT_GLYPH_PX / 2,
};

/** Padding at the header row's start that clears the lights (CSS px). */
export function trafficLightsInsetStart(
  lights: TrafficLightsRect,
  zoom: number,
): number {
  return Math.ceil(
    (lights.right - SHELL_PADDING_PX - SHELL_CARD_BORDER_PX + TRAFFIC_LIGHT_GAP_PX) /
      zoom,
  );
}

/**
 * CSS px a content-less spacer must cover so content clears the lights
 * (the Welcome screen, which has no header card to host them).
 */
export function trafficLightsClearance(
  lights: TrafficLightsRect,
  zoom: number,
): number {
  return Math.ceil((lights.bottom + TRAFFIC_LIGHT_CLEARANCE_GAP_PX) / zoom);
}

/*
 * One measurement per page load, shared by every consumer: the pin is a
 * window-level fact, not a component's. Rust keeps re-applying it on the
 * window events that would undo it, so nothing here has to re-run.
 */
let measuredTrafficLights: TrafficLightsRect | null = null;
let placement: Promise<void> | null = null;
const trafficLightListeners = new Set<() => void>();

function placeTrafficLights(): Promise<void> {
  placement ??= (async () => {
    if (!isTauri() || getDesktopOs() !== "macos") return;
    try {
      const rect = await invoke<TrafficLightsRect | null>(
        "place_traffic_lights",
        { centerY: TRAFFIC_LIGHT_CENTRE_Y_PX },
      );
      if (!rect) return;
      measuredTrafficLights = rect;
      trafficLightListeners.forEach((listener) => listener());
    } catch (error) {
      console.warn("[titlebar] traffic-light placement failed", error);
    }
  })();
  return placement;
}

function subscribeTrafficLights(listener: () => void): () => void {
  trafficLightListeners.add(listener);
  return () => {
    trafficLightListeners.delete(listener);
  };
}

function readTrafficLights(): TrafficLightsRect {
  return measuredTrafficLights ?? FALLBACK_TRAFFIC_LIGHTS;
}

/** The lights' rect: measured once Rust has pinned them, fallback before. */
function useTrafficLights(): TrafficLightsRect {
  const rect = useSyncExternalStore(
    subscribeTrafficLights,
    readTrafficLights,
    readTrafficLights,
  );
  useEffect(() => {
    void placeTrafficLights();
  }, []);
  return rect;
}

/**
 * What the workspace shell needs to lay its floating chrome around the OS:
 * on macOS the padding, header height and start inset are physical-pixel
 * budgets over the zoom (see above); elsewhere they are rem classes like
 * the rest of the UI and `insetStart` is nothing.
 */
export interface ShellChromeMetrics {
  os: ReturnType<typeof getDesktopOs>;
  /** The shell root's padding and gap (macOS: inline px over zoom), and
   *  the `--shell-header-height` var every header-height row reads. */
  rootStyle: CSSProperties;
  rootClassName: string;
  /** The same gap for a column of cards inside the root. */
  stackStyle: CSSProperties | undefined;
  stackClassName: string;
  /** Padding-inline-start that clears the traffic lights (macOS only). */
  insetStart: number | undefined;
}

/** The faint wash the dock's tab strips paint over the card colour (their
 *  "empty" run beside the tabs); the sidebar's header row wears the same
 *  wash. Theme-aware in styles.css. */
export const SHELL_CHROME_WASH_CLASS = "shell-chrome-wash";

/**
 * Every row that must line up across the window — the sidebar's header,
 * the dock's top tab bar, the Windows control card — is exactly this tall.
 * The shell root sets the var (rem off macOS, physical px over zoom on it).
 */
export const SHELL_HEADER_HEIGHT_CLASS = "h-[var(--shell-header-height)]";
const HEADER_HEIGHT_VAR = "--shell-header-height";
/** The gap between the shell's cards, for the sidebar's collapse tween. */
const GAP_VAR = "--shell-gap";

export function useShellChromeMetrics(): ShellChromeMetrics {
  const os = getDesktopOs();
  const { settings } = useAppSettings();
  const zoom = settings.zoomLevel || 1;
  const lights = useTrafficLights();
  if (os !== "macos") {
    return {
      os,
      rootStyle: {
        [HEADER_HEIGHT_VAR]: "1.5rem",
        [GAP_VAR]: "0.5rem",
      } as CSSProperties,
      rootClassName: "p-2 gap-2",
      stackStyle: undefined,
      stackClassName: "gap-2",
      insetStart: undefined,
    };
  }
  const padding = SHELL_PADDING_PX / zoom;
  return {
    os,
    rootStyle: {
      padding,
      gap: padding,
      [HEADER_HEIGHT_VAR]: `${SHELL_HEADER_HEIGHT_PX / zoom}px`,
      [GAP_VAR]: `${padding}px`,
    } as CSSProperties,
    rootClassName: "",
    stackStyle: { gap: padding },
    stackClassName: "",
    insetStart: trafficLightsInsetStart(lights, zoom),
  };
}

/** The floating-card surface every piece of shell chrome shares. */
export const SHELL_CARD_CLASS =
  "rounded-lg border border-border bg-card shadow-sm";

/**
 * A header-height floating card that is also a window drag region. The
 * sidebar's header and the Windows control cluster are both one of these
 * so they read as the same row across the window.
 */
export function ShellHeaderCard({
  className,
  style,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-tauri-drag-region
      {...rest}
      className={cn(
        SHELL_CARD_CLASS,
        "flex shrink-0 select-none items-center",
        SHELL_HEADER_HEIGHT_CLASS,
        className,
      )}
      style={{ WebkitAppRegion: "drag", ...style } as CSSProperties}
    >
      {children}
    </div>
  );
}

/**
 * Windows gets decorations: false (tauri.windows.conf.json) so the native
 * title bar never shows; the shell lays minimize/maximize/close into the
 * end of the dock's top tab bar instead. Nothing on the other platforms.
 */
export function WindowsControlsInline() {
  if (getDesktopOs() !== "windows") return null;
  return (
    <div className="flex h-full shrink-0 items-center border-s border-border px-1">
      <WindowsControls />
    </div>
  );
}

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
 * The content-less titlebar for screens with no shell chrome of their own
 * (Welcome): a drag-region spacer that clears the traffic lights on macOS,
 * the window controls on Windows, nothing on Linux.
 */
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
  const lights = useTrafficLights();

  // Native webview zoom scales CSS pixels but not the traffic lights, so
  // the clearance floor must be divided by the zoom factor.
  const minHeight = trafficLightsClearance(lights, settings.zoomLevel || 1);

  return (
    <div
      ref={ref}
      data-tauri-drag-region
      // -m-1/w-[calc(100%+1rem)] used to do this bleed, but both are
      // rem-based and silently grew (4px -> 6px pull-up) when the root
      // font-size moved to a 150% baseline, eating into
      // the clearance's fixed-px budget. Pinned to px so this
      // can't drift again the next time the root scale changes.
      className="texture-surface -m-[4px] w-[calc(100%+8px)] shrink-0 h-[5vh] md:h-[3vh] xl:h-[2.5vh] bg-background"
      style={{ WebkitAppRegion: "drag", minHeight } as CSSProperties}
    />
  );
}

// Kept deliberately low-contrast (no border, background matches the app)
// so it reads as part of the app's own chrome rather than a bolted-on OS
// title bar.
function WindowsTitlebar() {
  const ref = useTitlebarHeightVar<HTMLDivElement>();
  return (
    <div
      ref={ref}
      data-tauri-drag-region
      className="w-full shrink-0 h-5 bg-background flex items-center justify-end select-none"
      style={{ WebkitAppRegion: "drag" } as CSSProperties}
    >
      <WindowsControls />
    </div>
  );
}

/** The minimize / maximize / close cluster, in the card's own style. */
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
    "flex h-5 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors";

  return (
    <div
      className="flex items-center gap-px"
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      <ControlButton label={t("minimize")} onClick={minimize} className={buttonClass}>
        <Minus size={10} strokeWidth={1.5} />
      </ControlButton>
      <ControlButton label={t("maximize")} onClick={toggleMaximize} className={buttonClass}>
        <Square size={8} strokeWidth={1.5} />
      </ControlButton>
      <ControlButton
        label={t("close")}
        onClick={close}
        className={`${buttonClass} hover:bg-destructive hover:text-destructive-foreground`}
      >
        <X size={10} strokeWidth={1.5} />
      </ControlButton>
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className: string;
  children: ReactNode;
}) {
  return (
    <button type="button" aria-label={label} onClick={onClick} className={className}>
      {children}
    </button>
  );
}
