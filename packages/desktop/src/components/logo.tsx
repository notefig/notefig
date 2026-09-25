// The Notefig pear. Geometry mirrors scripts/build-icons.mjs (the source of
// every raster icon): a 1024 canvas, the mark 660 tall and centred, the tile
// a #F7EFE7 squircle with Apple's 22.37% corner ratio. Keep the two in step.
const BODY =
  "M74.4744 211C170.78 212.516 160.043 125.834 152.974 110C140.474 81.9999 137.604 83.2574 124.474 64.4999C117.474 54.4999 118.837 45.0908 115.974 36.4999C114.974 33.5 111.325 36.8062 113.474 29.5C118.474 12.4999 128.974 15 129.974 5.99992C130.641 -0.000283718 124.522 -9.40709e-05 121.509 0H121.474C108.236 1.24212e-05 104.602 8 102.974 12C96.057 29.0001 99.2921 20.7503 96.4741 28.5C94.4741 34 92.4746 31 90.4744 33.5C86.2885 38.7316 83.0104 45.6708 69.4741 56.5C46.9744 74.5 30.6686 81.9173 10.9743 110C-16.0256 148.5 7.41261 209.944 74.4744 211Z";
const LEAF =
  "M154.422 16.7531C137.35 11.5508 117.781 26.1789 117.781 27.5895C117.781 29.0001 127.438 48.525 143.719 50.5125C160 52.5 170 46.5 180 41C173.5 36 170 21.5001 154.422 16.7531Z";

export const LOGO_BODY_COLOR = "#C56A4A";
export const LOGO_LEAF_COLOR = "#8C8F72";
export const LOGO_TILE_COLOR = "#F7EFE7";

// translate/scale that puts the 180×211 mark at 660px tall, centred on 1024.
const MARK_TRANSFORM = "translate(230.474 182) scale(3.128)";

interface LogoProps {
  size?: number | string;
  animated?: boolean;
  hoverAnimate?: boolean;
  showBackground?: boolean;
  /** Monochrome override: paints body and leaf in one colour. */
  fill?: string;
  className?: string;
}

export default function Logo({
  size = 128,
  animated = false,
  hoverAnimate = false,
  showBackground = true,
  fill,
  className = "",
}: LogoProps) {
  const shouldAnimate = animated || hoverAnimate;
  const animationClass = hoverAnimate ? "group" : "";

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={`${animationClass} ${className}`.trim()}
    >
      {shouldAnimate && (
        <defs>
          <linearGradient id="glaze" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="rgba(255,255,255,0)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.35)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
          <mask id="glaze-mask">
            <rect width="1024" height="1024" fill="url(#glaze)">
              <animateTransform
                attributeName="transform"
                type="translate"
                from="-1024 0"
                to="1024 0"
                dur="2.5s"
                repeatCount={hoverAnimate ? "1" : "indefinite"}
                begin={hoverAnimate ? "indefinite" : "0s"}
              />
            </rect>
          </mask>
        </defs>
      )}

      {showBackground && (
        <rect
          width="1024"
          height="1024"
          rx="229"
          ry="229"
          fill={LOGO_TILE_COLOR}
          className="dark:fill-[#4A3A32]"
        />
      )}

      <g
        transform={MARK_TRANSFORM}
        {...(shouldAnimate ? { mask: "url(#glaze-mask)" } : {})}
      >
        <path fill={fill ?? LOGO_LEAF_COLOR} d={LEAF} />
        <path fill={fill ?? LOGO_BODY_COLOR} d={BODY} />
      </g>
    </svg>
  );
}

export function AnimatedLogo(props: Omit<LogoProps, "animated">) {
  return <Logo {...props} animated={true} />;
}

export function PlainLogo(
  props: Omit<LogoProps, "animated" | "showBackground">,
) {
  return <Logo {...props} animated={false} showBackground={false} />;
}
