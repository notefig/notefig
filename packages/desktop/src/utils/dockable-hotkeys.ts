/** Class on the block-selection shadow input (portaled outside the dockable root). */
export const BLOCK_SELECTION_SHADOW_INPUT_CLASS = "slate-shadow-input";

/**
 * Whether dockable tab hotkeys should run for the current focus target.
 *
 * Block selection moves focus to a hidden input portaled to `document.body`, so
 * hotkeys scoped only to the dockable container never receive those events.
 */
export function isDockableHotkeyFocusTarget(
  activeElement: Element | null,
  dockableRoot: HTMLElement | null,
): boolean {
  if (!activeElement) return false;
  if (dockableRoot?.contains(activeElement)) return true;
  return activeElement.classList.contains(BLOCK_SELECTION_SHADOW_INPUT_CLASS);
}
