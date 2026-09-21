import React, { createContext, useContext } from "react";
import type { LayoutNode } from "./utils/serializeLayout";

type DockableState = {
  children: LayoutNode[];
};

type DockableContextType = {
  state: DockableState;
  dispatch: React.Dispatch<any>;
};

export const StoreContext = createContext<DockableContextType | undefined>(
  undefined,
);

export function useDockable() {
  const context = useContext(StoreContext);
  if (context === undefined) {
    throw new Error("useDockable must be used within a DockableProvider");
  }
  return context;
}

/**
 * Chrome the host lays into the dock's tab bars: `tabBarLeading` renders at
 * the start of the top-left window's tab bar (and alone when that window
 * hides its tabs). The host's collapsed sidebar header lives here so the
 * dock can take the whole width without the header row moving.
 */
export type DockChrome = {
  tabBarLeading: React.ReactNode;
  /** Rendered at the end of the top tab bar at the reading direction's
   *  end (top-right in LTR): the Windows window controls. */
  tabBarTrailing: React.ReactNode;
  /** True while the leading chrome is in use (the sidebar is collapsed);
   *  the top-left bar drops its start margin to meet it. */
  tabBarLeadingActive: boolean;
  /** Physical-left clearance (px) the physically leftmost top bar keeps
   *  for the macOS lights when the layout is RTL — the sidebar sits on
   *  the right then, so the dock is what the lights overlap. */
  endInset: number | null;
};

export const DEFAULT_DOCK_CHROME: DockChrome = {
  tabBarLeading: null,
  tabBarTrailing: null,
  tabBarLeadingActive: false,
  endInset: null,
};

export const DockChromeContext = createContext<DockChrome>(DEFAULT_DOCK_CHROME);

export function useDockChrome() {
  return useContext(DockChromeContext);
}
