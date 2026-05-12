import { isTauri } from "@/utils/platform";

export function Titlebar() {
  if (!isTauri()) return null;

  return (
    <div
      data-tauri-drag-region
      className="texture-surface -m-1 w-[calc(100%+1rem)] shrink-0 h-[5vh] md:h-[3vh] xl:h-[2.5vh] min-h-5 bg-background"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    />
  );
}
