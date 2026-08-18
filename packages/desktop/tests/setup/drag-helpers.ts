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
  options: {
    whileOverTarget?: () => Promise<void>;
    /**
     * What the drag source permits, as a real source would declare it.
     * Defaults to a browser-initiated drag nobody has constrained;
     * `@pierre/trees` rows, for one, declare "move".
     */
    effectAllowed?: string;
  } = {},
) {
  // Phase 1: dragstart on the source + dragover on the target. The shared
  // DataTransfer is stashed on window so phase 2 can finish the same drag
  // after an optional mid-hover assertion. Selectors are resolved with a
  // shadow-piercing query (tree rows live in @pierre/trees' shadow root),
  // and events are dispatched composed so they cross shadow boundaries the
  // way real native drag events do.
  const begin = ({
    sourceSelector,
    targetSelector,
    effectAllowed,
  }: {
    sourceSelector: string;
    targetSelector: string;
    effectAllowed: string;
  }) => {
    const deepQuery = (selector: string): HTMLElement | null => {
      const search = (root: Document | ShadowRoot): HTMLElement | null => {
        const direct = root.querySelector<HTMLElement>(selector);
        if (direct) return direct;
        for (const el of root.querySelectorAll("*")) {
          if (el.shadowRoot) {
            const found = search(el.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      };
      return search(document);
    };

    const source = deepQuery(sourceSelector);
    const target = deepQuery(targetSelector);
    if (!source) throw new Error(`missing drag source: ${sourceSelector}`);
    if (!target) throw new Error(`missing drag target: ${targetSelector}`);

    // NOT `new DataTransfer()`: one made by the constructor is stuck on
    // effectAllowed "none" — it is not attached to a drag operation, so
    // Chromium ignores writes to it — and a zone that honours the source's
    // permitted effects would refuse every synthetic drop. Real drags never
    // look like that. A plain stand-in carries the whole surface the
    // protocol touches and lets the drag declare what it permits.
    const store = new Map<string, string>();
    const dataTransfer = {
      effectAllowed,
      dropEffect: "none",
      files: [] as File[],
      get types() {
        return [...store.keys()];
      },
      setData: (type: string, value: string) => void store.set(type, value),
      getData: (type: string) => store.get(type) ?? "",
      setDragImage: () => {},
    };

    const rect = target.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom - 2,
    };
    const dragEvent = (type: string) => {
      const event = new DragEvent(type, opts);
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      return event;
    };

    (window as unknown as Record<string, unknown>).__mtrSyntheticDrag = {
      source,
      target,
      dragEvent,
    };
    source.dispatchEvent(dragEvent("dragstart"));
    target.dispatchEvent(dragEvent("dragover"));
  };

  const finish = () => {
    const state = (window as unknown as Record<string, unknown>)
      .__mtrSyntheticDrag as {
      source: HTMLElement;
      target: HTMLElement;
      dragEvent: (type: string) => DragEvent;
    };
    delete (window as unknown as Record<string, unknown>).__mtrSyntheticDrag;
    state.target.dispatchEvent(state.dragEvent("drop"));
    state.source.dispatchEvent(state.dragEvent("dragend"));
  };

  await page.evaluate(begin, {
    sourceSelector,
    targetSelector,
    effectAllowed: options.effectAllowed ?? "uninitialized",
  });
  if (options.whileOverTarget) {
    await options.whileOverTarget();
  }
  await page.evaluate(finish);
}
