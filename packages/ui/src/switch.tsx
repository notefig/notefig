import * as React from "react";
import { cn } from "./utils";

interface SwitchProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange"
> {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

function Switch({
  className,
  checked,
  defaultChecked,
  onCheckedChange,
  disabled,
  ...props
}: SwitchProps) {
  const [internalChecked, setInternalChecked] = React.useState(
    defaultChecked || false,
  );
  const isChecked = checked !== undefined ? checked : internalChecked;

  const handleChange = () => {
    if (disabled) return;

    const newChecked = !isChecked;
    if (checked === undefined) {
      setInternalChecked(newChecked);
    }
    onCheckedChange?.(newChecked);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isChecked}
      disabled={disabled}
      onClick={handleChange}
      className={cn(
        "peer inline-flex h-[1.15rem] w-8 shrink-0 items-center rounded-full border border-transparent shadow-sm transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        isChecked ? "bg-primary" : "bg-input",
        className,
      )}
      {...props}
    >
      <div
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background transition-transform",
          isChecked
            ? "translate-x-[calc(100%-2px)] rtl:-translate-x-[calc(100%-2px)]"
            : "translate-x-0",
        )}
      />
    </button>
  );
}

export { Switch };
