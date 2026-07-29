import type { ComponentProps, CSSProperties } from "react";
import { useTheme } from "@/components/theme-provider";
import { Toaster as Sonner } from "sonner";

type ToasterProps = ComponentProps<typeof Sonner>;

/**
 * Sonner paints toasts from its own CSS variables, which default to flat
 * white/black. Its rules are `:where()`-wrapped so our classes already win on
 * the toast itself, but the variables still leak into the parts we don't
 * class over (close button, hover states), so point them at our tokens too.
 * Only the `normal` set matters: `richColors` is off, so every toast type
 * renders with these.
 */
const SONNER_THEME_VARS = {
  "--normal-bg": "hsl(var(--popover))",
  "--normal-text": "hsl(var(--popover-foreground))",
  "--normal-border": "hsl(var(--border))",
} as CSSProperties;

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme } = useTheme();

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      style={SONNER_THEME_VARS}
      toastOptions={{
        classNames: {
          // Toasts are a floating surface, so they get what every other
          // floating surface gets: the popover tokens plus the noise texture
          // (see popover.tsx). Without `texture-surface` a toast reads as a
          // flat white/black card against textured panels.
          toast:
            "group toast texture-surface group-[.toaster]:bg-popover group-[.toaster]:text-popover-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          closeButton:
            "group-[.toast]:bg-popover group-[.toast]:text-muted-foreground group-[.toast]:border-border group-[.toast]:hover:bg-muted group-[.toast]:hover:text-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
