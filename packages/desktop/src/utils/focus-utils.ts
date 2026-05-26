export function isSidebarTextEntryActive(
  activeElement: Element | null,
): boolean {
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.closest("[data-sidebar]")) return false;

  return !!activeElement.closest(
    'input, textarea, [contenteditable="true"], [role="textbox"]',
  );
}
