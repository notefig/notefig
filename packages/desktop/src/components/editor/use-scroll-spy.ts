import { useCallback, useEffect, useRef, useState } from "react";

/** Attribute marking a spy-tracked section; the value is the section id. */
export const SECTION_ATTRIBUTE = "data-settings-section";

/**
 * How far below the container's top edge a section heading must sit before it
 * counts as "the one you're reading". A small offset so a section activates as
 * its heading reaches the top rather than a moment after.
 */
const ACTIVATION_OFFSET = 24;

/**
 * Fractional layout means a section scrolled exactly to the line can measure a
 * hair below it; without this slack the section you just jumped to loses to the
 * one above by a subpixel.
 */
const ACTIVATION_EPSILON = 2;

function readSections(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`[${SECTION_ATTRIBUTE}]`),
  );
}

function sectionTop(container: HTMLElement, section: HTMLElement) {
  return (
    section.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
}

/**
 * Tracks which `[data-settings-section]` inside the scroll container is
 * currently at the top of the viewport.
 *
 * Position arithmetic rather than an IntersectionObserver: sections here differ
 * wildly in height, and "last heading at or above the activation line" is a
 * single exact rule, where an observer would need per-section thresholds.
 *
 * The container is claimed with the returned callback ref, not a `useRef`: it
 * lives inside a dialog that mounts a commit later than this hook's effects, so
 * a ref object would still read `null` when they first run.
 */
export function useScrollSpy() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * A section a jump asked for but the layout has not delivered yet. Content
   * below the fold (the harness list) arrives after the first paint and pushes
   * everything down, so a single jump lands short; the pin re-applies it until
   * the section really is at the top, and holds `activeId` there meanwhile so
   * nothing downstream mistakes the shortfall for the user scrolling.
   */
  const pinned = useRef<string | null>(null);

  useEffect(() => {
    // The container goes away with the dialog. Forgetting the section along
    // with it keeps a reopen from reporting the one that was on screen last
    // time, which would overwrite the section the URL asked for.
    if (!container) {
      setActiveId(null);
      return;
    }

    let frame: number | null = null;

    const measure = () => {
      frame = null;
      const sections = readSections(container);
      if (sections.length === 0) return;

      if (pinned.current && keepPinned()) return;

      const line = container.scrollTop + ACTIVATION_OFFSET;
      let active = sections[0];
      for (const section of sections) {
        if (sectionTop(container, section) <= line + ACTIVATION_EPSILON)
          active = section;
      }
      setActiveId(active.getAttribute(SECTION_ATTRIBUTE));
    };

    /**
     * Re-apply the pinned section, and report whether it is still short of the
     * top (in which case the caller leaves `activeId` alone).
     */
    const keepPinned = () => {
      const section = container.querySelector<HTMLElement>(
        `[${SECTION_ATTRIBUTE}="${pinned.current}"]`,
      );
      if (!section) {
        pinned.current = null;
        return false;
      }
      const desired = sectionTop(container, section) - ACTIVATION_OFFSET;
      const reachable = Math.min(
        desired,
        container.scrollHeight - container.clientHeight,
      );
      if (Math.abs(container.scrollTop - reachable) > 1) {
        container.scrollTo({ top: desired, behavior: "auto" });
        return true;
      }
      pinned.current = null;
      return false;
    };

    /** Any scrolling of their own hands the position back to the user. */
    const release = () => {
      pinned.current = null;
    };

    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(measure);
    };

    measure();
    container.addEventListener("scroll", schedule, { passive: true });
    container.addEventListener("wheel", release, { passive: true });
    container.addEventListener("touchstart", release, { passive: true });
    container.addEventListener("keydown", release);

    // Sections grow and shrink under us (the harness editor sub-view, window
    // resizes), so both the container and every section are observed.
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    for (const section of readSections(container)) observer.observe(section);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      container.removeEventListener("scroll", schedule);
      container.removeEventListener("wheel", release);
      container.removeEventListener("touchstart", release);
      container.removeEventListener("keydown", release);
      observer.disconnect();
    };
  }, [container]);

  const scrollToSection = useCallback(
    (id: string, behavior: ScrollBehavior = "smooth") => {
      const section = container?.querySelector<HTMLElement>(
        `[${SECTION_ATTRIBUTE}="${id}"]`,
      );
      if (!container || !section) return false;

      // Claim the target up front: the URL mirror reads `activeId` in the same
      // commit, and a smooth scroll would otherwise leave it reporting the
      // section we are leaving.
      setActiveId(id);
      // Only a jump is pinned. A glide is the user's own click, already at the
      // right place by the time it ends, and re-applying it mid-flight would
      // cut the animation short.
      pinned.current = behavior === "auto" ? id : null;
      container.scrollTo({
        top: sectionTop(container, section) - ACTIVATION_OFFSET,
        behavior,
      });
      return true;
    },
    [container],
  );

  return { setContainer, activeId, scrollToSection };
}
