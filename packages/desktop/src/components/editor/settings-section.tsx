import React, { createContext, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@notefig/ui/utils";

/** The section header's slot for controls, filled by whatever the section
 *  holds — the section only knows it has one. */
const ActionsSlot = createContext<HTMLElement | null>(null);

export function SettingsSection({
  id,
  title,
  last,
  children,
}: {
  id: string;
  title?: string;
  last?: boolean;
  children: React.ReactNode;
}) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <section
      data-settings-section={id}
      className={cn(
        "space-y-2 py-6",
        // The final section stretches to a full viewport height so that it,
        // too, can scroll up to the activation line and light up in the index.
        last ? "min-h-full" : "border-b border-border",
      )}
    >
      {title && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <div ref={setSlot} className="flex flex-wrap items-center gap-3 empty:hidden" />
        </div>
      )}
      <ActionsSlot.Provider value={slot}>{children}</ActionsSlot.Provider>
    </section>
  );
}

/** Renders its children in the enclosing section's header, beside the
 *  title; nothing while the header is mounting, or in a section without one. */
export function SettingsSectionActions({ children }: { children: React.ReactNode }) {
  const slot = useContext(ActionsSlot);
  return slot ? createPortal(children, slot) : null;
}
