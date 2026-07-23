import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { copyTextToClipboard } from "@/utils/clipboard";

/**
 * Copy-a-message affordance (MET-94), shared by the chat transcript's
 * message footers and the widget's done face: flips to a check (and
 * "Copied", when labeled) for a beat after a copy. Base chrome matches
 * the transcript's other small icon buttons; hosts add
 * hover-reveal/sizing via className.
 */
export function CopyTextButton({
  text,
  className,
  iconClassName = "size-3.5",
  withLabel = false,
}: {
  text: string;
  className?: string;
  iconClassName?: string;
  /** Render the "Copy"/"Copied" text next to the icon (the opencode-style
   *  message footer); icon-only otherwise. */
  withLabel?: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timeoutRef.current), []);
  const copy = async () => {
    await copyTextToClipboard(text);
    setCopied(true);
    clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      title={t("copyMessage")}
      aria-label={t("copyMessage")}
      className={cn(
        // Ghost: hover only brightens the glyph — a background block behind
        // a tiny inline icon reads as a jarring flash, not an affordance.
        "flex shrink-0 cursor-pointer items-center gap-1 rounded p-1 text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
      onClick={() => void copy()}
    >
      {copied ? (
        <Check className={iconClassName} />
      ) : (
        <Copy className={iconClassName} />
      )}
      {withLabel && <span>{copied ? t("copied") : t("copy")}</span>}
    </button>
  );
}
