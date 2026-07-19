import { Button } from "@/components/ui/button"
import { Header } from "./header"
import { GrainOverlay } from "./grain-overlay"
import Link from "next/link"

export function HeroSection() {
  return (
    <section
      className="flex flex-col items-center text-center relative mx-auto rounded-2xl overflow-hidden my-6 py-0 px-4
         w-full h-[400px] md:w-[1220px] md:h-[600px] lg:h-[810px] md:px-0 border border-foreground/[0.06]"
    >
      {/* CSS Background */}
      <div className="absolute inset-0 z-0">
        {/* Faint dashed-style grid, fading in toward the bottom-right */}
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "linear-gradient(to right, hsl(var(--foreground) / 0.11) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--foreground) / 0.11) 1px, transparent 1px)",
            backgroundSize: "36px 36px",
            maskImage: "linear-gradient(135deg, transparent 0%, transparent 15%, black 95%)",
            WebkitMaskImage: "linear-gradient(135deg, transparent 0%, transparent 15%, black 95%)",
          }}
        />
        {/* Primary glow radiating from the top-right corner */}
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(130% 130% at 88% -12%, hsl(var(--foreground)) 0%, hsl(var(--primary-light)) 16%, hsl(var(--primary)) 36%, hsl(var(--primary) / 0.35) 52%, transparent 70%)",
          }}
        />
        <GrainOverlay id="noise-hero-fx" className="opacity-[0.28]" />
      </div>

      {/* Header positioned at top of hero container */}
      <div className="absolute top-0 left-0 right-0 z-20">
        <Header />
      </div>

      <div className="relative z-10 space-y-4 md:space-y-5 lg:space-y-6 mb-6 md:mb-7 lg:mb-9 max-w-md md:max-w-[500px] lg:max-w-[588px] mt-16 md:mt-[120px] lg:mt-[160px] px-4">
        <h1 className="text-foreground text-3xl md:text-4xl lg:text-6xl font-semibold leading-tight">
          Unleash the Power of AI Agents
        </h1>
        <p className="text-muted-foreground text-base md:text-base lg:text-lg font-medium leading-relaxed max-w-lg mx-auto">
          Accelerate your development workflow with intelligent AI agents that write, review, and optimize your code.
        </p>
      </div>

      <Link href="https://vercel.com/home" target="_blank" rel="noopener noreferrer">
        <Button className="relative z-10 bg-secondary text-secondary-foreground hover:bg-secondary/90 px-8 py-3 rounded-full font-medium text-base shadow-lg ring-1 ring-white/10">
          Signup for free
        </Button>
      </Link>
    </section>
  )
}
