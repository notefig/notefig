/**
 * The minimap rail, as a ProseMirror plugin view — the UI lives inside the
 * editor, so registering the extension is the whole installation.
 *
 * Vanilla DOM by necessity (plugin views are imperative; Tiptap only
 * portals React into node views) and by fit: the rail is a projection with
 * a hover state, not an app surface. Tailwind's group-hover classes work
 * on plain elements, so the visual language is shared verbatim with the
 * rest of the package.
 *
 * Layout: the rail mounts inside the editor's scroll container through a
 * zero-height `position: sticky` host, so it stays pinned near the
 * viewport's top-right while the document scrolls beneath it — no wrapper
 * or mount point required from the application.
 *
 * Rendering: four svg groups in paint order — the pulse underlay (waves
 * travel beneath everything), the gooey layer (line + bumps under a
 * blur + alpha-contrast filter; opaque, dimmed via color-mix so it
 * occludes the underlay), and the punch layer (background-colored holes;
 * at full opacity, never dimmed, so a hollow dot truly reads as empty).
 * A plain button layer above carries hover, click, tooltip, aria.
 */
// The rail's stylesheet belongs to this module — it styles the DOM built
// here — but the import must not run where no DOM exists: the markdown
// worker reaches this file statically (worker → widgetSchemaNodes → package
// index → registry → extension → rail-view), and in dev Vite injects CSS by
// touching `document` DURING graph evaluation — before the worker's DOM
// shim installs — which crashed the worker and silently moved every
// markdown conversion onto the main thread. A DOM-guarded dynamic import
// keeps the stylesheet renderer-only; in the page it resolves long before
// any editor mounts a rail.
if (typeof document !== "undefined") void import("./minimap.css");

import type { EditorView } from "@tiptap/pm/view";
import type { PluginView } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  MINIMAP_STILL_DOT,
  deriveMinimapEntries,
  type MinimapDotState,
  type MinimapEntry,
  type MinimapObserver,
  type MinimapSource,
} from "./contract";

const SVG_NS = "http://www.w3.org/2000/svg";

const GOO_LAYER_CLASS =
  "text-[color-mix(in_oklab,hsl(var(--muted-foreground))_50%,hsl(var(--background)))] transition-colors duration-200 group-hover/map:text-[color-mix(in_oklab,hsl(var(--muted-foreground))_80%,hsl(var(--background)))]";
const SIDE_LAYER_CLASS =
  "opacity-80 transition-opacity duration-200 group-hover/map:opacity-100";
/* "Holds a result" is a tonal shift of the whole bump, not an inner core:
   the vessel's clay deepens when it's full — the same neutral deepening
   for error as for fresh, since the error wave alone carries the red. It
   carries its own group-hover variant because overriding the inherited
   color detaches the bump from the goo group's hover transition. */
const BUMP_FULL_CLASS =
  "text-[color-mix(in_oklab,hsl(var(--muted-foreground))_85%,hsl(var(--background)))] transition-colors duration-200 group-hover/map:text-[hsl(var(--muted-foreground))]";
const NEUTRAL_WAVE_CLASS = "fill-foreground/70";
const ERROR_WAVE_CLASS =
  "fill-[color-mix(in_oklab,hsl(var(--destructive))_55%,hsl(var(--background)))]";
const TOOLTIP_CLASS =
  "pointer-events-none absolute right-full top-1/2 z-10 mr-1 hidden max-w-[14rem] -translate-y-1/2 rounded border border-border bg-popover px-1.5 py-0.5 text-[0.625rem] leading-tight shadow-sm group-hover/dot:block";
const TOOLTIP_STATE_CLASS = "block truncate font-medium text-foreground";
const TOOLTIP_TITLE_CLASS = "block truncate text-muted-foreground";
const BUTTON_CLASS =
  "group/dot absolute left-1/2 size-4 -translate-x-1/2 -translate-y-1/2 cursor-pointer border-0 bg-transparent p-0";

let nextFilterId = 0;

type Dot = {
  entry: MinimapEntry;
  state: MinimapDotState;
  hovered: boolean;
  bump: SVGCircleElement;
  wave: SVGCircleElement;
  punch: SVGCircleElement;
  button: HTMLButtonElement;
  tooltipState: HTMLSpanElement;
  tooltipTitle: HTMLSpanElement;
};

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

/** The nearest scrollable ancestor — where the sticky host must live. */
function findScroller(from: HTMLElement): HTMLElement {
  let el: HTMLElement | null = from.parentElement;
  while (el) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return el;
    el = el.parentElement;
  }
  return from.parentElement ?? from;
}

export class MinimapRailView implements PluginView {
  private readonly view: EditorView;
  private readonly sources: Record<string, MinimapSource>;
  private readonly reveal: ((id: string) => void) | undefined;
  private readonly stickyHost: HTMLDivElement;
  private readonly nav: HTMLElement;
  private readonly underlay: SVGGElement;
  private readonly goo: SVGGElement;
  private readonly punches: SVGGElement;
  private readonly buttons: HTMLDivElement;
  private dots: Dot[] = [];
  private observers = new Map<string, MinimapObserver>();
  private lastSerialized = "";

  constructor(
    view: EditorView,
    sources: Record<string, MinimapSource>,
    reveal?: (id: string) => void,
  ) {
    this.view = view;
    this.sources = sources;
    this.reveal = reveal;

    this.stickyHost = document.createElement("div");
    // Zero-height sticky overlay: pinned to the scrollport, no layout cost.
    this.stickyHost.style.cssText =
      "position:sticky;top:0;height:0;overflow:visible;z-index:10;";

    this.nav = document.createElement("nav");
    this.nav.setAttribute("data-widget-minimap", "");
    this.nav.setAttribute("aria-label", "Prompt widgets in this document");
    this.nav.className = "group/map absolute right-2 top-6 h-28 w-3";
    this.nav.hidden = true;

    const svg = svgEl("svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute(
      "class",
      "pointer-events-none absolute inset-0 h-full w-full overflow-visible",
    );

    const filterId = `nf-minimap-goo-${nextFilterId++}`;
    const defs = svgEl("defs");
    const filter = svgEl("filter");
    filter.setAttribute("id", filterId);
    filter.setAttribute("x", "-150%");
    filter.setAttribute("y", "-25%");
    filter.setAttribute("width", "400%");
    filter.setAttribute("height", "150%");
    const blur = svgEl("feGaussianBlur");
    blur.setAttribute("in", "SourceGraphic");
    blur.setAttribute("stdDeviation", "1.4");
    blur.setAttribute("result", "blur");
    const matrix = svgEl("feColorMatrix");
    matrix.setAttribute("in", "blur");
    matrix.setAttribute("mode", "matrix");
    matrix.setAttribute(
      "values",
      "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7",
    );
    filter.append(blur, matrix);
    defs.append(filter);

    this.underlay = svgEl("g");
    this.underlay.setAttribute("class", SIDE_LAYER_CLASS);
    this.goo = svgEl("g");
    this.goo.setAttribute("filter", `url(#${filterId})`);
    this.goo.setAttribute("class", GOO_LAYER_CLASS);
    const line = svgEl("line");
    line.setAttribute("x1", "50%");
    line.setAttribute("x2", "50%");
    line.setAttribute("y1", "0%");
    line.setAttribute("y2", "100%");
    line.setAttribute("stroke", "currentColor");
    line.setAttribute("stroke-width", "2");
    this.goo.append(line);
    // No dimming class: a punch is a hole, and a background-colored
    // circle at less than full opacity lets the bump bleed through as a
    // phantom solid core.
    this.punches = svgEl("g");
    svg.append(defs, this.underlay, this.goo, this.punches);

    this.buttons = document.createElement("div");
    this.buttons.className = "relative h-full";

    this.nav.append(svg, this.buttons);
    this.stickyHost.append(this.nav);
    const scroller = findScroller(view.dom);
    scroller.insertBefore(this.stickyHost, scroller.firstChild);

    this.render();
  }

  update(): void {
    this.render();
  }

  destroy(): void {
    for (const observer of this.observers.values()) observer.destroy();
    this.observers.clear();
    this.stickyHost.remove();
  }

  private render(): void {
    const entries = deriveMinimapEntries(this.view.state.doc, this.sources);
    const serialized = JSON.stringify(entries);
    if (serialized === this.lastSerialized) return;
    this.lastSerialized = serialized;

    this.nav.hidden = entries.length === 0;
    this.reconcileDots(entries);
    this.syncObservers(entries);
    // A created dot for an already-observed identity (a duplicated marker)
    // starts still — pull every observer's current state onto its dots.
    for (const key of this.observers.keys()) this.applyObserver(key);
  }

  /**
   * Reconcile dots against the new entries, reusing DOM per identity
   * (observerKey, disambiguated per duplicate occurrence). Reuse is what
   * keeps CSS animations running: entries change on every document edit
   * (ratios shift with doc size), and a recreated element restarts its
   * animation from frame zero — a streaming agent turn would freeze every
   * breathing and pulsing dot at its first frame.
   */
  private reconcileDots(entries: MinimapEntry[]): void {
    const occurrence = new Map<string, number>();
    const reuseKeyOf = (observerKey: string) => {
      const n = occurrence.get(observerKey) ?? 0;
      occurrence.set(observerKey, n + 1);
      return `${observerKey}#${n}`;
    };
    const existing = new Map<string, Dot>();
    {
      const counts = new Map<string, number>();
      for (const dot of this.dots) {
        const n = counts.get(dot.entry.observerKey) ?? 0;
        counts.set(dot.entry.observerKey, n + 1);
        existing.set(`${dot.entry.observerKey}#${n}`, dot);
      }
    }

    const next: Dot[] = entries.map((entry) => {
      const key = reuseKeyOf(entry.observerKey);
      const reused = existing.get(key);
      if (reused) {
        existing.delete(key);
        return this.moveDot(reused, entry);
      }
      return this.createDot(entry);
    });

    // Anything not reused is gone from the document.
    const kept = new Set(next);
    for (const dot of this.dots) {
      if (kept.has(dot)) continue;
      dot.bump.remove();
      dot.wave.remove();
      dot.punch.remove();
      dot.button.remove();
    }
    this.dots = next;
  }

  /** Update a surviving dot's position and title in place — the DOM nodes
   *  (and their running animations) are untouched. */
  private moveDot(dot: Dot, entry: MinimapEntry): Dot {
    const y = `${entry.ratio * 100}%`;
    dot.entry = entry;
    for (const circle of [dot.bump, dot.wave, dot.punch]) {
      circle.setAttribute("cy", y);
    }
    dot.button.style.top = y;
    dot.tooltipTitle.textContent = entry.title;
    this.applyState(dot);
    return dot;
  }

  private createDot(entry: MinimapEntry): Dot {
    const y = `${entry.ratio * 100}%`;

    const bump = svgEl("circle");
    bump.setAttribute("cx", "50%");
    bump.setAttribute("cy", y);
    bump.setAttribute("fill", "currentColor");
    this.goo.append(bump);

    const wave = svgEl("circle");
    wave.setAttribute("cx", "50%");
    wave.setAttribute("cy", y);
    wave.style.animation = "nf-minimap-bubble 1.8s infinite";
    this.underlay.append(wave);

    const punch = svgEl("circle");
    punch.setAttribute("cx", "50%");
    punch.setAttribute("cy", y);
    punch.setAttribute("r", "1.75");
    punch.setAttribute("class", "fill-background");
    this.punches.append(punch);

    const button = document.createElement("button");
    button.type = "button";
    button.className = BUTTON_CLASS;
    button.style.top = y;
    const tooltip = document.createElement("span");
    tooltip.className = TOOLTIP_CLASS;
    const tooltipState = document.createElement("span");
    tooltipState.className = TOOLTIP_STATE_CLASS;
    const tooltipTitle = document.createElement("span");
    tooltipTitle.className = TOOLTIP_TITLE_CLASS;
    tooltipTitle.textContent = entry.title;
    tooltip.append(tooltipState, tooltipTitle);
    button.append(tooltip);
    this.buttons.append(button);

    const dot: Dot = {
      entry,
      state: MINIMAP_STILL_DOT,
      hovered: false,
      bump,
      wave,
      punch,
      button,
      tooltipState,
      tooltipTitle,
    };
    button.addEventListener("mouseenter", () => {
      dot.hovered = true;
      this.applyState(dot);
    });
    button.addEventListener("mouseleave", () => {
      dot.hovered = false;
      this.applyState(dot);
    });
    button.addEventListener("click", () => this.jumpTo(dot));
    this.applyState(dot);
    return dot;
  }

  /** One observer per identity; duplicated markers share their dot state. */
  private syncObservers(entries: MinimapEntry[]): void {
    const wanted = new Set(entries.map((e) => e.observerKey));
    for (const [key, observer] of this.observers) {
      if (!wanted.has(key)) {
        observer.destroy();
        this.observers.delete(key);
      }
    }
    for (const entry of entries) {
      if (this.observers.has(entry.observerKey)) continue;
      const source = this.sources[entry.nodeTypeName];
      if (!source.observe) continue;
      const handle = {
        getNode: (): PMNode | null => this.currentNode(entry.observerKey),
        getElement: (): HTMLElement | null => {
          const dot = this.dots.find(
            (d) => d.entry.observerKey === entry.observerKey,
          );
          if (!dot) return null;
          const dom = this.view.nodeDOM(dot.entry.pos);
          return dom instanceof HTMLElement ? dom : null;
        },
      };
      const key = entry.observerKey;
      const observer = source.observe(handle, () => this.applyObserver(key));
      this.observers.set(key, observer);
      this.applyObserver(key);
    }
  }

  private currentNode(observerKey: string): PMNode | null {
    const dot = this.dots.find((d) => d.entry.observerKey === observerKey);
    if (!dot) return null;
    return this.view.state.doc.nodeAt(dot.entry.pos);
  }

  private applyObserver(observerKey: string): void {
    const observer = this.observers.get(observerKey);
    if (!observer) return;
    const state = observer.get();
    for (const dot of this.dots) {
      if (dot.entry.observerKey !== observerKey) continue;
      dot.state = state;
      this.applyState(dot);
    }
  }

  private applyState(dot: Dot): void {
    const { state, hovered } = dot;

    dot.bump.style.r = hovered ? "6px" : "4px";
    dot.bump.style.transition = "r 150ms ease, color 200ms ease";
    dot.bump.setAttribute(
      "class",
      state.core === "fresh" || state.core === "error" ? BUMP_FULL_CLASS : "",
    );
    dot.bump.style.animation =
      state.breathe && !hovered
        ? "nf-minimap-breathe 2.4s ease-in-out infinite"
        : "";

    const showWave = state.ping;
    dot.wave.style.display = showWave ? "" : "none";
    dot.wave.setAttribute(
      "class",
      state.core === "error" ? ERROR_WAVE_CLASS : NEUTRAL_WAVE_CLASS,
    );

    dot.punch.style.display = state.hollow ? "" : "none";
    // Pulse by resizing the hole, never by fading it — a translucent
    // punch shows the bump through and the vessel stops reading as empty.
    dot.punch.style.animation = state.pulse
      ? "nf-minimap-punch-pulse 2s ease-in-out infinite"
      : "";

    // The state line teaches the dot vocabulary: a first-time user learns
    // what breathing or pulsing means by hovering the dot that does it.
    dot.tooltipState.textContent = state.label ?? "";
    dot.tooltipState.hidden = state.label === null;

    dot.button.setAttribute(
      "aria-label",
      `Jump to prompt: ${dot.entry.title}${state.label ? ` (${state.label})` : ""}`,
    );
  }

  private jumpTo(dot: Dot): void {
    if (this.reveal && dot.entry.id) {
      this.reveal(dot.entry.id);
      return;
    }
    const dom = this.view.nodeDOM(dot.entry.pos);
    if (dom instanceof HTMLElement) {
      dom.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}
