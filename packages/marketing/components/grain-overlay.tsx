import { cn } from "@/lib/utils"

interface GrainOverlayProps {
  /** Unique id so multiple overlays on the same page don't share a filter definition. */
  id: string
  className?: string
}

export function GrainOverlay({ id, className }: GrainOverlayProps) {
  return (
    <div
      className={cn("pointer-events-none absolute inset-0 z-10 opacity-[0.18] mix-blend-screen", className)}
      aria-hidden="true"
    >
      <svg className="h-full w-full">
        <filter id={id}>
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" stitchTiles="stitch" />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#${id})`} />
      </svg>
    </div>
  )
}
