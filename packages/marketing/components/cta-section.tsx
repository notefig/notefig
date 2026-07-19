import { Button } from "@/components/ui/button"
import { GrainOverlay } from "./grain-overlay"
import Link from "next/link"

export function CTASection() {
  return (
    <section className="w-full pt-20 md:pt-60 lg:pt-60 pb-10 md:pb-20 px-5 relative flex flex-col justify-center items-center overflow-visible">
      <div className="absolute inset-0 top-[-90px] overflow-hidden">
        {/* Primary glow radiating from the top center, fading out at the horizontal edges */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 70% at 50% 0%, hsl(var(--primary) / 0.55) 0%, hsl(var(--primary-dark) / 0.28) 28%, hsl(var(--primary) / 0.08) 48%, transparent 66%)",
            maskImage: "linear-gradient(to right, transparent 0%, black 22%, black 78%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(to right, transparent 0%, black 22%, black 78%, transparent 100%)",
          }}
        />
        <GrainOverlay id="noise-cta-fx" className="opacity-[0.28]" />
      </div>
      <div className="relative z-10 flex flex-col justify-start items-center gap-9 max-w-4xl mx-auto">
        <div className="flex flex-col justify-start items-center gap-4 text-center">
          <h2 className="text-foreground text-4xl md:text-5xl lg:text-[68px] font-semibold leading-tight md:leading-tight lg:leading-[76px] break-words max-w-[435px]">
            Coding made effortless
          </h2>
          <p className="text-muted-foreground text-sm md:text-base font-medium leading-[18.20px] md:leading-relaxed break-words max-w-2xl">
            Hear how developers ship products faster, collaborate seamlessly, and build with confidence using Pointer's
            powerful AI tools
          </p>
        </div>
        <Link href="https://vercel.com/home" target="_blank" rel="noopener noreferrer">
          <Button
            className="px-[30px] py-2 bg-secondary text-secondary-foreground text-base font-medium leading-6 rounded-[99px] shadow-[0px_0px_0px_4px_rgba(255,255,255,0.13)] hover:bg-secondary/90 transition-all duration-200"
            size="lg"
          >
            Signup for free
          </Button>
        </Link>
      </div>
    </section>
  )
}
