import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EditorView } from "@tiptap/pm/view";
import {
  type DragPayload,
  tagCurrentDrag,
  getDragPayload,
  getCurrentDragPayload,
  clearCurrentDragPayload,
  hasPayloadOfKind,
  dragSourceProps,
  dropZoneProps,
  installDragProtocol,
  uninstallDragProtocol,
  composeDropHandlers,
  createProtocolDropHandler,
} from "@/utils/drag-protocol";

/** Minimal DataTransfer stand-in (happy-dom has no real drag data store). */
class FakeDataTransfer {
  private store = new Map<string, string>();
  effectAllowed = "none";
  dropEffect = "none";
  files: File[] = [];

  get types(): string[] {
    return [...this.store.keys()];
  }
  setData(type: string, value: string) {
    this.store.set(type, value);
  }
  getData(type: string): string {
    return this.store.get(type) ?? "";
  }
}

const filePayload: DragPayload = {
  kind: "file",
  path: "/ws/notes/a.md",
  fileType: "file",
  workspaceRoot: "/ws",
};

function dragEvent(
  type: string,
  target: Element | Window,
  dataTransfer: FakeDataTransfer,
): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  if (target instanceof Element) target.dispatchEvent(event);
  else window.dispatchEvent(event);
  return event as unknown as DragEvent;
}

beforeEach(() => {
  clearCurrentDragPayload();
});

afterEach(() => {
  uninstallDragProtocol();
  document.body.innerHTML = "";
});

describe("payload wire format", () => {
  it("round-trips each payload kind through the JSON channel", () => {
    const payloads: DragPayload[] = [
      filePayload,
      {
        kind: "image-asset",
        src: "assets/x.png",
        absolutePath: "/ws/assets/x.png",
        workspaceRoot: "/ws",
        sourceFilePath: "/ws/doc.md",
      },
    ];
    for (const payload of payloads) {
      const dt = new FakeDataTransfer();
      tagCurrentDrag(payload, dt as unknown as DataTransfer);
      clearCurrentDragPayload(); // force the JSON fallback path
      expect(getDragPayload(dt as unknown as DataTransfer)).toEqual(payload);
    }
  });

  it("sets a types-only marker readable during dragover", () => {
    const dt = new FakeDataTransfer();
    tagCurrentDrag(filePayload, dt as unknown as DataTransfer);
    clearCurrentDragPayload();
    expect(
      hasPayloadOfKind(dt as unknown as DataTransfer, "file"),
    ).toBe(true);
    expect(
      hasPayloadOfKind(dt as unknown as DataTransfer, "image-asset"),
    ).toBe(false);
  });

  it("prefers the in-memory record over the JSON channel", () => {
    const dt = new FakeDataTransfer();
    tagCurrentDrag(filePayload, dt as unknown as DataTransfer);
    expect(getCurrentDragPayload()).toEqual(filePayload);
    // No dataTransfer needed while the record is live (dragover case).
    expect(getDragPayload(null)).toEqual(filePayload);
    expect(hasPayloadOfKind(null, "file")).toBe(true);
  });

  it("returns null for malformed or missing JSON", () => {
    const dt = new FakeDataTransfer();
    dt.setData("application/x-notefig+json", "{nope");
    expect(getDragPayload(dt as unknown as DataTransfer)).toBeNull();
    expect(getDragPayload(new FakeDataTransfer() as unknown as DataTransfer)).toBeNull();
    expect(getDragPayload(null)).toBeNull();
  });
});

describe("drop zone registration", () => {
  it("registers on ref attach and unregisters on ref detach", () => {
    installDragProtocol();
    const onDrop = vi.fn();
    const props = dropZoneProps({ accepts: ["file"], onDrop });
    const target = document.createElement("div");
    target.setAttribute("data-mtr-dropzone", props["data-mtr-dropzone"]);
    document.body.append(target);

    props.ref(target);
    tagCurrentDrag(filePayload);
    dragEvent("drop", target, new FakeDataTransfer());
    expect(onDrop).toHaveBeenCalledTimes(1);

    props.ref(null); // unmount
    tagCurrentDrag(filePayload);
    dragEvent("drop", target, new FakeDataTransfer());
    expect(onDrop).toHaveBeenCalledTimes(1);
  });
});

describe("delegated dispatch", () => {
  let onDrop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installDragProtocol();
    onDrop = vi.fn();
  });

  function mountSourceAndTarget() {
    const source = document.createElement("div");
    Object.entries(dragSourceProps(filePayload)).forEach(([key, value]) =>
      source.setAttribute(key, String(value)),
    );
    const target = document.createElement("div");
    const targetProps = dropZoneProps({
      accepts: ["file"],
      dropEffect: "copy",
      onDrop,
    });
    target.setAttribute("data-mtr-dropzone", targetProps["data-mtr-dropzone"]);
    targetProps.ref(target);
    const inner = document.createElement("span"); // drops land on descendants
    target.appendChild(inner);
    document.body.append(source, target);
    return { source, target, inner };
  }

  it("dragstart on a data-mtr-drag element populates both channels", () => {
    const { source } = mountSourceAndTarget();
    const dt = new FakeDataTransfer();
    dragEvent("dragstart", source, dt);
    expect(getCurrentDragPayload()).toEqual(filePayload);
    expect(dt.types).toContain("application/x-notefig-file");
    expect(dt.effectAllowed).toBe("copyMove");
  });

  it("dragover an accepting target prevents default and stamps hover attr", () => {
    const { source, inner, target } = mountSourceAndTarget();
    dragEvent("dragstart", source, new FakeDataTransfer());
    const over = dragEvent("dragover", inner, new FakeDataTransfer());
    expect(over.defaultPrevented).toBe(true);
    expect(target.getAttribute("data-mtr-drop-over")).toBe("true");
  });

  it("dragover a non-accepting drag leaves the event untouched", () => {
    const { inner, target } = mountSourceAndTarget();
    tagCurrentDrag({
      kind: "image-asset",
      src: "assets/x.png",
      absolutePath: "/ws/assets/x.png",
      workspaceRoot: "/ws",
      sourceFilePath: "/ws/doc.md",
    });
    const over = dragEvent("dragover", inner, new FakeDataTransfer());
    expect(over.defaultPrevented).toBe(false);
    expect(target.hasAttribute("data-mtr-drop-over")).toBe(false);
  });

  it("drop invokes the zone callback with the payload, then clears", async () => {
    const { source, inner } = mountSourceAndTarget();
    dragEvent("dragstart", source, new FakeDataTransfer());
    dragEvent("drop", inner, new FakeDataTransfer());
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][0]).toEqual(filePayload);
    await Promise.resolve(); // registry clears in a microtask
    expect(getCurrentDragPayload()).toBeNull();
  });

  it("dragend clears the registry and hover state", () => {
    const { source, inner, target } = mountSourceAndTarget();
    dragEvent("dragstart", source, new FakeDataTransfer());
    dragEvent("dragover", inner, new FakeDataTransfer());
    dragEvent("dragend", source, new FakeDataTransfer());
    expect(getCurrentDragPayload()).toBeNull();
    expect(target.hasAttribute("data-mtr-drop-over")).toBe(false);
  });

});

describe("ProseMirror protocol drop handler", () => {
  const view = {} as EditorView;

  it("falls through on internal moves regardless of payload", () => {
    tagCurrentDrag(filePayload);
    const handler = createProtocolDropHandler();
    const event = { dataTransfer: null } as unknown as DragEvent;
    expect(handler(view, event, null, true)).toBe(false);
  });

  it("consumes drops a zone already handled (defaultPrevented)", () => {
    const handler = createProtocolDropHandler();
    const event = {
      dataTransfer: null,
      defaultPrevented: true,
    } as unknown as DragEvent;
    expect(handler(view, event, null, false)).toBe(true);
  });

  it("falls through when no payload exists (OS image drops)", () => {
    const handler = createProtocolDropHandler();
    const event = {
      dataTransfer: new FakeDataTransfer(),
    } as unknown as DragEvent;
    expect(handler(view, event, null, false)).toBe(false);
  });

  it("consumes any tagged payload so PM never inserts a text form", () => {
    tagCurrentDrag(filePayload);
    const handler = createProtocolDropHandler();
    const event = { dataTransfer: null } as unknown as DragEvent;
    expect(handler(view, event, null, false)).toBe(true);
  });

  it("composeDropHandlers stops at the first handler returning true", () => {
    const first = vi.fn().mockReturnValue(true);
    const second = vi.fn().mockReturnValue(true);
    const composed = composeDropHandlers(first, second);
    expect(composed(view, {} as DragEvent, null, false)).toBe(true);
    expect(second).not.toHaveBeenCalled();

    const failing = vi.fn().mockReturnValue(false);
    const composed2 = composeDropHandlers(failing, second);
    expect(composed2(view, {} as DragEvent, null, false)).toBe(true);
    expect(failing).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });
});
