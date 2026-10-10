import { Bot } from "lucide-react";
import { cn } from "@notefig/ui/utils";
import { harnessLogo } from "@/modules/harness-adapters";

/**
 * A harness's brand mark, shown wherever a harness name appears (pickers,
 * composer indicator), drawn from its adapter's `logo`. Monochrome via
 * currentColor so it follows the surrounding text in both themes; a harness
 * without one (a user-configured one, MET-67) gets a generic bot.
 */
export function HarnessLogo({
  harnessId,
  className,
}: {
  harnessId: string;
  className?: string;
}) {
  const cls = cn("size-3.5 shrink-0", className);
  const mark = harnessLogo(harnessId);
  if (!mark) return <Bot className={cls} />;
  return (
    <svg
      className={cls}
      fill="currentColor"
      fillRule={mark.fillRule}
      viewBox={mark.viewBox}
      aria-hidden="true"
    >
      {mark.paths.map((path) => (
        <path key={path.d} d={path.d} opacity={path.opacity} />
      ))}
    </svg>
  );
}
