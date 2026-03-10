import { useEffect, useCallback } from "react";
import { useAppSettings } from "@/hooks/use-app-settings";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.1;

/**
 * Manages application zoom level via CSS zoom on <html>.
 * - Restores persisted zoom on mount
 * - Intercepts Cmd/Ctrl + =/−/0 to zoom in, out, or reset
 * - Persists every change to app settings
 */
export function useZoom() {
  const { settings, setZoomLevel } = useAppSettings();

  const applyZoom = useCallback((zoom: number) => {
    document.documentElement.style.zoom = String(zoom);
  }, []);

  // Apply zoom whenever the persisted value changes (including initial load)
  useEffect(() => {
    applyZoom(settings.zoomLevel);
  }, [settings.zoomLevel, applyZoom]);

  // Keyboard zoom: Cmd/Ctrl + =/-/0
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      let newZoom: number | null = null;

      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        const current = settings.zoomLevel ?? 1;
        newZoom = Math.min(
          MAX_ZOOM,
          Math.round((current + ZOOM_STEP) * 100) / 100,
        );
      } else if (e.key === "-") {
        e.preventDefault();
        const current = settings.zoomLevel ?? 1;
        newZoom = Math.max(
          MIN_ZOOM,
          Math.round((current - ZOOM_STEP) * 100) / 100,
        );
      } else if (e.key === "0") {
        e.preventDefault();
        newZoom = 1;
      }

      if (newZoom !== null) {
        applyZoom(newZoom);
        setZoomLevel(newZoom);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settings.zoomLevel, applyZoom, setZoomLevel]);
}
