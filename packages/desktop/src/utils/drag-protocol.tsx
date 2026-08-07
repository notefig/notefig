/**
 * Notefig drag-and-drop protocol. See docs/dnd-protocol.md.
 *
 * Standardizes drag payloads across the app's DnD contexts without
 * replacing any context's engine:
 *
 * 1. Payloads + wire format — an in-memory record for same-window drags,
 *    plus marker/JSON MIME channels on native DataTransfers (dataTransfer
 *    data is unreadable during dragover; only `types` is).
 * 2. Declarative layer — `dragSourceProps` declares what an element
 *    registers when dragged; `dropZoneProps` takes a colocated drop
 *    callback. A fixed set of delegated window listeners routes native
 *    drags; `ProtocolDndContext` routes pointer (dnd-kit) drags into the
 *    same zone registry.
 * 3. ProseMirror adoption — `createProtocolDropHandler` composed into
 *    editorProps.handleDrop keeps PM behaviors (block reorder, OS image
 *    drops) untouched while consuming protocol payloads.
 */

import { useRef, useState, type ReactElement, type ReactNode } from "react";
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
/* Payloads & wire format                                              */
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
    };

export type DragPayloadKind = DragPayload["kind"];

export type PayloadOfKind<K extends DragPayloadKind> = Extract<
  DragPayload,
  { kind: K }
>;

const JSON_MIME = "application/x-notefig+json";
const markerMime = (kind: DragPayloadKind) => `application/x-notefig-${kind}`;

let currentDrag: DragPayload | null = null;

export function getCurrentDragPayload(): DragPayload | null {
  return currentDrag;
}

export function clearCurrentDragPayload(): void {
  currentDrag = null;
}

/**
 * Record the in-flight drag's payload; when a DataTransfer is given
 * (native drags), also write the marker + JSON channels.
 */
export function tagCurrentDrag(
  payload: DragPayload,
  dataTransfer?: DataTransfer | null,
): void {
  currentDrag = payload;
  if (!dataTransfer) return;
  dataTransfer.setData(markerMime(payload.kind), "");
  dataTransfer.setData(JSON_MIME, JSON.stringify(payload));
}

/** Read the in-flight payload: in-memory record first, JSON fallback. */
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
/* App context — non-serializable capabilities zones need at drop time */
/* ------------------------------------------------------------------ */

export interface DragProtocolContext {
  openFile: (options: OpenFileInLayoutOptions) => boolean;
}

let protocolContext: Partial<DragProtocolContext> = {};

/** Registered by the providers that own the capability (workspace tabs). */
export function registerProtocolContext(
  context: Partial<DragProtocolContext>,
): void {
  protocolContext = { ...protocolContext, ...context };
}

export function getProtocolContext(): Partial<DragProtocolContext> {
  return protocolContext;
}

/* ------------------------------------------------------------------ */
/* Declarative layer + delegated native listeners                      */
/* ------------------------------------------------------------------ */

const DRAG_ATTR = "data-mtr-drag";
const DROP_ATTR = "data-mtr-dropzone";
const DROP_OVER_ATTR = "data-mtr-drop-over";

/** Where a drop landed — identical for both engines. */
export interface DropInfo {
  /** The registered zone element the drop landed on. */
  element: HTMLElement;
  /** Viewport drop point. */
  position: { x: number; y: number };
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

/** Spreadable props making an element a native drag source. */
export function dragSourceProps(payload: DragPayload): {
  draggable: boolean;
  [DRAG_ATTR]: string;
} {
  installDragProtocol();
  return { draggable: true, [DRAG_ATTR]: JSON.stringify(payload) };
}

/**
 * Spreadable props making an element a drop zone. The callback is held in
 * a WeakMap keyed by the element (via the returned ref), so registration
 * follows the DOM node's lifecycle and context is just closure capture.
 */
export function dropZoneProps<K extends DragPayloadKind>(
  config: DropZoneConfig<K>,
): { [DROP_ATTR]: string; ref: (element: Element | null) => void } {
  installDragProtocol();
  let current: Element | null = null;
  return {
    [DROP_ATTR]: "true",
    ref: (element: Element | null) => {
      if (element) {
        // Dispatch re-checks `accepts` before calling onDrop.
        dropZones.set(element, config as unknown as DropZoneConfig);
        current = element;
      } else if (current) {
        dropZones.delete(current);
        current = null;
      }
    },
  };
}

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

  clearCurrentDragPayload();
  tagCurrentDrag(payload, event.dataTransfer);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copyMove";
}

function handleDragOver(event: DragEvent): void {
  const hit = closestDropZone(event);
  if (!hit || !hasPayloadOfKind(event.dataTransfer, ...hit.config.accepts)) {
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
  // Clear only when leaving the hovered zone for somewhere outside it.
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
    });
  } finally {
    // dragend usually clears too, but drops that unmount the source can
    // swallow it.
    queueMicrotask(clearCurrentDragPayload);
  }
}

function handleDragEnd(): void {
  setHoveredDropElement(null);
  clearCurrentDragPayload();
}

let installed = false;

/**
 * Install the delegated window listeners. Idempotent, inert without the
 * protocol attributes, and called lazily by the prop helpers — exported
 * only for tests.
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
/* Pointer engine (dnd-kit) — same zone registry, better drag UX       */
/* ------------------------------------------------------------------ */

/** Innermost registered drop zone under a viewport point. */
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

/**
 * dnd-kit draggable wired to the protocol: spread `setNodeRef`,
 * `listeners`, `attributes` on the element. Requires ProtocolDndContext.
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
 * DndContext dispatching pointer drags into the shared drop-zone
 * registry. `overlay` renders the floating drag preview.
 */
export function ProtocolDndContext(props: {
  children: ReactNode;
  overlay?: (payload: DragPayload) => ReactNode;
}): ReactElement {
  // Refs, not state, drive the handlers: dnd-kit can emit a trailing
  // onDragMove after onDragEnd, and event.delta is scroll-compensated so
  // it diverges from the pointer during auto-scroll. State only renders
  // the overlay.
  const activePayloadRef = useRef<DragPayload | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const trackPointer = useRef((event: PointerEvent) => {
    pointerRef.current = { x: event.clientX, y: event.clientY };
  }).current;
  const [activePayload, setActivePayload] = useState<DragPayload | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const finish = () => {
    window.removeEventListener("pointermove", trackPointer);
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
    const activator = event.activatorEvent as Partial<PointerEvent>;
    pointerRef.current = {
      x: activator.clientX ?? 0,
      y: activator.clientY ?? 0,
    };
    window.addEventListener("pointermove", trackPointer);
    tagCurrentDrag(payload);
    activePayloadRef.current = payload;
    setActivePayload(payload);
  };

  const handleMove = (_event: DragMoveEvent) => {
    const payload = activePayloadRef.current;
    if (!payload) return;
    const { x, y } = pointerRef.current;
    const hit = dropZoneAtPoint(x, y);
    setHoveredDropElement(
      hit && hit.config.accepts.includes(payload.kind) ? hit.element : null,
    );
  };

  const handleEnd = (_event: DragEndEvent) => {
    const payload = activePayloadRef.current;
    const { x, y } = pointerRef.current;
    finish();
    if (!payload) return;
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
      {createPortal(
        // pointer-events none so the overlay tracking the cursor never
        // swallows the elementFromPoint hit-test
        <DragOverlay
          zIndex={999}
          dropAnimation={null}
          style={{ pointerEvents: "none" }}
        >
          {activePayload ? props.overlay?.(activePayload) : null}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/* ------------------------------------------------------------------ */
/* ProseMirror adoption                                                */
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
 * editorProps.handleDrop link consuming protocol payloads so ProseMirror
 * never double-handles or inserts a serialized form of them. Must run
 * before other handlers; falls through for internal PM moves and
 * payload-less drags (block reorder and OS image drops stay untouched).
 * Behavior for protocol drops on the editor lives in its drop zone.
 */
export function createProtocolDropHandler(): ProseMirrorDropHandler {
  return (_view, event, _slice, moved) => {
    if (moved) return false;
    if (event.defaultPrevented) return true;
    return getDragPayload(event.dataTransfer) !== null;
  };
}
