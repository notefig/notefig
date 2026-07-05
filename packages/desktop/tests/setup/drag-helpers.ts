/**
 * Shared drag-and-drop test helpers for the drag protocol
 * (src/utils/drag-protocol.tsx, docs/dnd-protocol.md).
 *
 * Two engines, two helpers:
 *
 * - `pointerDrag` — real mouse input for pointer-driven (dnd-kit) drags:
 *   file-tree rows, dockable tabs. Exceeds the sensor's activation
 *   distance before travelling, mirroring an actual user gesture.
 *
 * - `syntheticNativeDrag` — synthetic DragEvents sharing one DataTransfer
 *   for native HTML5 drags (ProseMirror-owned image nodes, OS file drops).
 *   Playwright cannot reliably drive real native drags against
 *   ProseMirror/delegated handlers, so this is the industry-standard
 *   fallback (same approach as editor-visual.spec.ts block reorder).
 */
import { type Page } from "@playwright/test";

/**
 * Pointer-driven drag (dnd-kit engine) between two elements' centers.
 * `hover` lets a test pause mid-drag (e.g. to assert drop-over highlight)
 * by providing a callback that runs while the pointer is over the target.
 */
export async function pointerDrag(
  page: Page,
  sourceSelector: string,
  targetSelector: string,
  options: { whileOverTarget?: () => Promise<void> } = {},
) {
  const source = await page.locator(sourceSelector).first().boundingBox();
  const target = await page.locator(targetSelector).first().boundingBox();
  if (!source) throw new Error(`missing drag source: ${sourceSelector}`);
  if (!target) throw new Error(`missing drag target: ${targetSelector}`);

  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  // exceed the sensor's activation constraint before travelling
  await page.mouse.move(
    source.x + source.width / 2 + 12,
    source.y + source.height / 2 + 12,
    { steps: 3 },
  );
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 10 },
  );
  if (options.whileOverTarget) {
    await options.whileOverTarget();
  }
  await page.mouse.up();
}

/**
 * Native HTML5 drag driven by synthetic DragEvents sharing one
 * DataTransfer (what a real native drag does). Coordinates land on the
 * bottom-center of the target so ProseMirror's dropPoint resolves
 * deterministically.
 */
export async function syntheticNativeDrag(
  page: Page,
  sourceSelector: string,
  targetSelector: string,
) {
  await page.evaluate(
    ({ sourceSelector, targetSelector }) => {
      const source = document.querySelector<HTMLElement>(sourceSelector);
      const target = document.querySelector<HTMLElement>(targetSelector);
      if (!source) throw new Error(`missing drag source: ${sourceSelector}`);
      if (!target) throw new Error(`missing drag target: ${targetSelector}`);

      const rect = target.getBoundingClientRect();
      const dataTransfer = new DataTransfer();
      const opts = {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: rect.left + rect.width / 2,
        clientY: rect.bottom - 2,
      };
      source.dispatchEvent(new DragEvent("dragstart", opts));
      target.dispatchEvent(new DragEvent("dragover", opts));
      target.dispatchEvent(new DragEvent("drop", opts));
      source.dispatchEvent(
        new DragEvent("dragend", { bubbles: true, dataTransfer }),
      );
    },
    { sourceSelector, targetSelector },
  );
}
