/**
 * Metrists drag-and-drop protocol.
 *
 * Standardizes drag payloads across the app's DnD contexts (file tree,
 * dockable tabs, TipTap editor, future OS drops) without replacing any
 * context's internal engine. See docs/dnd-protocol.md for the full design.
 *
 * Three layers, all in this file — feature code only ever imports from here:
 *
 * 1. Payload types + wire format. Dual channel per drag (the pragmatic-dnd
 *    pattern): a marker MIME per kind (`application/x-metrists-<kind>`,
 *    readable via dataTransfer.types during dragover) plus the full JSON
 *    under `application/x-metrists+json` (readable on drop, cross-window),
 *    plus an in-memory record for same-window drags.
 *
 * 2. Declarative attribute layer. Drag sources opt in with spreadable
 *    props (`dragSourceProps` / `DragSource`) declaring the payload they
 *    register on drag; drop zones opt in with `dropZoneProps`, passing a
 *    self-contained drop callback colocated with the element. A fixed set
 *    of window-level delegated listeners routes everything — a thousand
 *    tree rows add zero listeners.
 *
 * 3. Escape hatches for non-DOM consumers: ProseMirror adopts the protocol
 *    through `createProtocolDropHandler` composed via `composeDropHandlers`,
 *    and tags its own native drags with `tagCurrentDrag`.
 */

import {
  cloneElement,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { EditorView } from "@tiptap/pm/view";
import type { OpenFileInLayoutOptions } from "@/utils/dockable-layout";

/* ------------------------------------------------------------------ */
/* Layer 1 — payload types & wire format                               */
/* ------------------------------------------------------------------ */

export type DragPayload =
  | {
      kind: "file";
      /** Absolute path; doubles as the tab id in the dockable layout. */
      path: string;
      fileType: "file" | "directory";
      workspaceRoot: string;
    }
  | {
      kind: "image-asset";
      /** Workspace-relative src as stored in the markdown (e.g. assets/x.png). */
      src: string;
      absolutePath: string;
      workspaceRoot: string;
      /** Document the image node lives in, so its src can be rewritten. */
      sourceFilePath: string;
    }
  | { kind: "tab"; tabId: string }
  | { kind: "os-files"; paths: string[] };

export type DragPayloadKind = DragPayload["kind"];

export type PayloadOfKind<K extends DragPayloadKind> = Extract<
  DragPayload,
  { kind: K }
>;

const JSON_MIME = "application/x-metrists+json";
const markerMime = (kind: DragPayloadKind) => `application/x-metrists-${kind}`;

/**
 * Same-window drag record. dataTransfer data is unreadable during dragover
 * (only `types` is exposed), so accept-checks and hover feedback read this
 * instead; the JSON channel remains the cross-window fallback on drop.
 */
let currentDrag: DragPayload | null = null;

export function getCurrentDragPayload(): DragPayload | null {
  return currentDrag;
}

export function clearCurrentDragPayload(): void {
  currentDrag = null;
}

/**
 * Record a payload for the in-flight drag and, when a DataTransfer is given,
 * write both wire channels. Used by the delegated dragstart listener and by
 * imperative sources that own their dragstart (e.g. ProseMirror image nodes).
 */
export function tagCurrentDrag(
  payload: DragPayload,
  dataTransfer?: DataTransfer | null,
): void {
  currentDrag = payload;
  if (!dataTransfer) return;

  dataTransfer.setData(markerMime(payload.kind), "");
  dataTransfer.setData(JSON_MIME, JSON.stringify(payload));

  if (payload.kind === "file") {
    dataTransfer.setData("text/uri-list", encodeURI(`file://${payload.path}`));
    // The editor's protocol drop handler consumes file drops before
    // ProseMirror can paste this as text (see createProtocolDropHandler).
    dataTransfer.setData("text/plain", payload.path);
  }
}

/** Read the in-flight payload: in-memory record first, JSON channel fallback. */
export function getDragPayload(
  dataTransfer?: DataTransfer | null,
): DragPayload | null {
  if (currentDrag) return currentDrag;
  const raw = dataTransfer?.getData(JSON_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "kind" in parsed
      ? (parsed as DragPayload)
      : null;
  } catch {
    return null;
  }
}

/** Dragover-safe check — inspects marker MIMEs / the in-memory record only. */
export function hasPayloadOfKind(
  dataTransfer: DataTransfer | null | undefined,
  ...kinds: DragPayloadKind[]
): boolean {
  if (currentDrag && kinds.includes(currentDrag.kind)) return true;
  if (!dataTransfer) return false;
  return kinds.some((kind) => dataTransfer.types.includes(markerMime(kind)));
}

/* ------------------------------------------------------------------ */
/* App context — non-serializable dependencies actions need at drop    */
/* ------------------------------------------------------------------ */

export interface DragProtocolContext {
  openFile: (options: OpenFileInLayoutOptions) => boolean;
}

let protocolContext: Partial<DragProtocolContext> = {};

/**
 * Provide app capabilities (openFile, …) to drop actions. Called from
 * providers that own them (mirrors the focus-arbiter decoupling pattern);
 * actions read lazily at drop time via `getProtocolContext`.
 */
export function registerProtocolContext(
  context: Partial<DragProtocolContext>,
): void {
  protocolContext = { ...protocolContext, ...context };
}

export function getProtocolContext(): Partial<DragProtocolContext> {
  return protocolContext;
}

/* ------------------------------------------------------------------ */
/* Layer 2 — declarative attribute layer + delegated listeners         */
/* ------------------------------------------------------------------ */

const DRAG_ATTR = "data-mtr-drag";
const DROP_ATTR = "data-mtr-dropzone";
const DROP_OVER_ATTR = "data-mtr-drop-over";

/** Where a drop landed — available to every zone regardless of engine. */
export interface DropInfo {
  /** The registered zone element the drop landed on. */
  element: HTMLElement;
  /** Viewport drop point. */
  position: { x: number; y: number };
  /** Native DragEvent; undefined for pointer-driven (dnd-kit) drags. */
  event?: DragEvent;
}

export interface DropZoneConfig<
  K extends DragPayloadKind = DragPayloadKind,
> {
  /** Payload kinds this zone reacts to; everything else passes through. */
  accepts: readonly K[];
  dropEffect?: "copy" | "move";
  /** Self-contained drop behavior, colocated with the element. */
  onDrop: (payload: PayloadOfKind<K>, info: DropInfo) => void;
}

/** Element → config registry; entries die with their DOM nodes. */
const dropZones = new WeakMap<Element, DropZoneConfig>();

/**
 * Spreadable props that make an element a protocol drag source, declaring
 * the payload it registers when dragged. No listeners — the delegated
 * dragstart listener picks the element up via the attribute.
 */
export function dragSourceProps(
  payload: DragPayload,
  opts?: { disabled?: boolean },
): { draggable: boolean; [DRAG_ATTR]?: string } {
  installDragProtocol(); // lazy, idempotent — first declaration wires the listeners
  if (opts?.disabled) return { draggable: false };
  return { draggable: true, [DRAG_ATTR]: JSON.stringify(payload) };
}

/**
 * Spreadable props that make an element a drop zone. The callback is held
 * in a WeakMap keyed by the element (registered through the returned ref),
 * so registration follows the DOM node's lifecycle automatically and any
 * context the handler needs is just a closure capture.
 */
export function dropZoneProps<K extends DragPayloadKind>(
  config: DropZoneConfig<K>,
): { [DROP_ATTR]: string; ref: (element: Element | null) => void } {
  installDragProtocol(); // lazy, idempotent — first declaration wires the listeners
  let current: Element | null = null;
  return {
    [DROP_ATTR]: "true",
    ref: (element: Element | null) => {
      if (element) {
        // Runtime dispatch re-checks `accepts` before calling onDrop, so
        // widening the payload type here is safe.
        dropZones.set(element, config as unknown as DropZoneConfig);
        current = element;
      } else if (current) {
        dropZones.delete(current);
        current = null;
      }
    },
  };
}

/** Wrapper flavor of `dragSourceProps` for elements we don't render ourselves. */
export function DragSource(props: {
  payload: DragPayload;
  disabled?: boolean;
  children: ReactElement;
}): ReactElement {
  return cloneElement(
    props.children,
    dragSourceProps(props.payload, { disabled: props.disabled }) as never,
  );
}

/* ---- delegated listeners ---- */

function closestDropZone(event: DragEvent): {
  element: HTMLElement;
  config: DropZoneConfig;
} | null {
  const target = event.target;
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>(`[${DROP_ATTR}]`);
  if (!element) return null;
  const config = dropZones.get(element);
  if (!config) return null;
  return { element, config };
}

function zoneAcceptsCurrentDrag(
  config: DropZoneConfig,
  event: DragEvent,
): boolean {
  return hasPayloadOfKind(event.dataTransfer, ...config.accepts);
}

let hoveredDropElement: HTMLElement | null = null;

function setHoveredDropElement(element: HTMLElement | null): void {
  if (hoveredDropElement === element) return;
  hoveredDropElement?.removeAttribute(DROP_OVER_ATTR);
  hoveredDropElement = element;
  element?.setAttribute(DROP_OVER_ATTR, "true");
}

function handleDragStart(event: DragEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const source = target.closest<HTMLElement>(`[${DRAG_ATTR}]`);
  if (!source) return;

  let payload: DragPayload;
  try {
    payload = JSON.parse(source.getAttribute(DRAG_ATTR)!);
  } catch {
    return;
  }

  // A new drag always supersedes any stale record (dragend can be missed
  // when a drag is cancelled by the OS).
  clearCurrentDragPayload();
  tagCurrentDrag(payload, event.dataTransfer);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed =
      payload.kind === "file" || payload.kind === "image-asset"
        ? "copyMove"
        : "copy";
  }
}

function handleDragOver(event: DragEvent): void {
  const hit = closestDropZone(event);
  if (!hit || !zoneAcceptsCurrentDrag(hit.config, event)) {
    setHoveredDropElement(null);
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = hit.config.dropEffect ?? "copy";
  }
  setHoveredDropElement(hit.element);
}

function handleDragLeave(event: DragEvent): void {
  // Only clear when leaving the hovered target for somewhere outside it.
  if (!hoveredDropElement) return;
  const related = event.relatedTarget;
  if (related instanceof Node && hoveredDropElement.contains(related)) return;
  if (event.target instanceof Node && hoveredDropElement.contains(event.target)) {
    setHoveredDropElement(null);
  }
}

function handleDrop(event: DragEvent): void {
  setHoveredDropElement(null);
  const hit = closestDropZone(event);
  if (!hit) return;

  const payload = getDragPayload(event.dataTransfer);
  if (!payload || !hit.config.accepts.includes(payload.kind)) return;

  event.preventDefault();

  try {
    hit.config.onDrop(payload, {
      element: hit.element,
      position: { x: event.clientX, y: event.clientY },
      event,
    });
  } finally {
    // Same-window drags also get a dragend on the source, but drops onto
    // targets that remove the source from the DOM can swallow it.
    queueMicrotask(clearCurrentDragPayload);
  }
}

function handleDragEnd(): void {
  setHoveredDropElement(null);
  clearCurrentDragPayload();
}

let installed = false;

/**
 * Install the delegated window listeners. Idempotent and inert until an
 * element carries the protocol attributes. Called lazily by
 * `dragSourceProps`/`dropZoneProps`, so app code never needs to call it —
 * exported for tests and unusual bootstrap orders.
 */
export function installDragProtocol(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("dragstart", handleDragStart, true);
  window.addEventListener("dragover", handleDragOver, true);
  window.addEventListener("dragleave", handleDragLeave, true);
  window.addEventListener("drop", handleDrop, true);
  window.addEventListener("dragend", handleDragEnd, true);
}

/** Test-only teardown. */
export function uninstallDragProtocol(): void {
  if (!installed) return;
  installed = false;
  window.removeEventListener("dragstart", handleDragStart, true);
  window.removeEventListener("dragover", handleDragOver, true);
  window.removeEventListener("dragleave", handleDragLeave, true);
  window.removeEventListener("drop", handleDrop, true);
  window.removeEventListener("dragend", handleDragEnd, true);
  setHoveredDropElement(null);
  clearCurrentDragPayload();
}

/* ------------------------------------------------------------------ */
/* Layer 2b — pointer-driven drags (dnd-kit engine)                    */
/*                                                                     */
/* Native HTML5 drags are hard to control (OS ghost image, coarse      */
/* activation, no auto-scroll). For app-internal sources we reuse the  */
/* same engine as the dockable tabs: dnd-kit pointer drags with a      */
/* DragOverlay. The protocol stays engine-agnostic — on move/end the   */
/* bridge hit-tests the SAME drop-zone registry, so a zone declared    */
/* with dropZoneProps reacts identically to native and pointer drags.  */
/* ------------------------------------------------------------------ */

/** Find the innermost registered drop zone under a viewport point. */
function dropZoneAtPoint(
  x: number,
  y: number,
): { element: HTMLElement; config: DropZoneConfig } | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const element = hit.closest<HTMLElement>(`[${DROP_ATTR}]`);
  if (!element) return null;
  const config = dropZones.get(element);
  if (!config) return null;
  return { element, config };
}

function pointFromDndEvent(event: DragMoveEvent | DragEndEvent): {
  x: number;
  y: number;
} {
  const activator = event.activatorEvent as Partial<PointerEvent>;
  return {
    x: (activator.clientX ?? 0) + event.delta.x,
    y: (activator.clientY ?? 0) + event.delta.y,
  };
}

/**
 * dnd-kit draggable wired to the protocol: spread the returned
 * `setNodeRef`/`listeners`/`attributes` on the element and the declared
 * payload travels through the drag. Must render inside ProtocolDndContext.
 */
export function useProtocolDraggable(args: {
  id: string;
  payload: DragPayload;
  disabled?: boolean;
}) {
  return useDraggable({
    id: args.id,
    data: { mtrPayload: args.payload },
    disabled: args.disabled,
  });
}

/**
 * DndContext that dispatches pointer drags of protocol payloads into the
 * shared drop-zone registry. `overlay` renders the floating drag preview.
 */
export function ProtocolDndContext(props: {
  children: ReactNode;
  overlay?: (payload: DragPayload) => ReactNode;
}): ReactElement {
  // The ref is the source of truth for handlers: dnd-kit can deliver a
  // trailing onDragMove after onDragEnd, and a state-based guard would
  // read a stale closure and re-stamp the drop-over highlight after the
  // drop cleared it. State exists only to render the overlay.
  const activePayloadRef = useRef<DragPayload | null>(null);
  const [activePayload, setActivePayload] = useState<DragPayload | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const finish = () => {
    activePayloadRef.current = null;
    setHoveredDropElement(null);
    clearCurrentDragPayload();
    setActivePayload(null);
  };

  const handleStart = (event: DragStartEvent) => {
    const payload = event.active.data.current?.mtrPayload as
      | DragPayload
      | undefined;
    if (!payload) return;
    tagCurrentDrag(payload);
    activePayloadRef.current = payload;
    setActivePayload(payload);
  };

  const handleMove = (event: DragMoveEvent) => {
    const payload = activePayloadRef.current;
    if (!payload) return;
    const { x, y } = pointFromDndEvent(event);
    const hit = dropZoneAtPoint(x, y);
    setHoveredDropElement(
      hit && hit.config.accepts.includes(payload.kind) ? hit.element : null,
    );
  };

  const handleEnd = (event: DragEndEvent) => {
    const payload = activePayloadRef.current;
    finish();
    if (!payload) return;
    const { x, y } = pointFromDndEvent(event);
    const hit = dropZoneAtPoint(x, y);
    if (hit && hit.config.accepts.includes(payload.kind)) {
      hit.config.onDrop(payload as never, {
        element: hit.element,
        position: { x, y },
      });
    }
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleStart}
      onDragMove={handleMove}
      onDragEnd={handleEnd}
      onDragCancel={finish}
    >
      {props.children}
      {/* pointer-events none on the overlay wrapper — it tracks the cursor
          and would otherwise swallow the elementFromPoint hit-test */}
      {createPortal(
        <DragOverlay
          zIndex={999}
          dropAnimation={null}
          style={{ pointerEvents: "none" }}
        >
          {activePayload ? (
            <div style={{ pointerEvents: "none" }}>
              {props.overlay?.(activePayload)}
            </div>
          ) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/* ------------------------------------------------------------------ */
/* Layer 3 — ProseMirror adoption                                      */
/* ------------------------------------------------------------------ */

export type ProseMirrorDropHandler = (
  view: EditorView,
  event: DragEvent,
  slice: unknown,
  moved: boolean,
) => boolean;

/** Chain editorProps.handleDrop handlers; first one returning true wins. */
export function composeDropHandlers(
  ...handlers: ProseMirrorDropHandler[]
): ProseMirrorDropHandler {
  return (view, event, slice, moved) =>
    handlers.some((handler) => handler(view, event, slice, moved));
}

/**
 * editorProps.handleDrop link that consumes protocol payloads dropped onto
 * the editor surface. Ordering is load-bearing: it must run BEFORE the
 * image-file drop handler, and it must fall through (return false) for
 * internal ProseMirror moves and for payload-less drags so existing
 * behavior — block reorder, OS image drops, plain text drops — is untouched.
 */
export function createProtocolDropHandler(): ProseMirrorDropHandler {
  return function handleProtocolDrop(_view, event, _slice, moved) {
    if (moved) return false;

    // The delegated window listener runs first (capture) — when a zone on
    // or around the editor already handled this drop, consume it here so
    // ProseMirror neither double-handles nor pastes a text form.
    if (event.defaultPrevented) return true;

    const payload = getDragPayload(event.dataTransfer);
    if (!payload) return false;

    switch (payload.kind) {
      case "file": {
        // Directories can't open in a tab; consume the drop anyway so
        // ProseMirror never pastes the payload's text/plain path as text.
        if (payload.fileType !== "file") return true;
        event.preventDefault();
        getProtocolContext().openFile?.({
          tabId: payload.path,
          intent: "new-tab",
        });
        return true;
      }
      case "image-asset":
        // In-editor image moves arrive with moved=true and are handled by
        // ProseMirror; a payload without `moved` means the drag ended on the
        // editor after being tagged for an external target. Consume it so
        // no text form of the payload is inserted.
        return true;
      default:
        return false;
    }
  };
}
